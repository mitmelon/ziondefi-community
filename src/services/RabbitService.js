const amqp = require('amqplib');

const DEFAULT_EXCHANGE = 'ziondefi.exchange';
const MAX_RETRY_ATTEMPTS = 5;

let connection = null;
let channel = null;

class RabbitService {
    /**
     * Get or create a persistent connection + channel
     */
    static async getChannel() {
        if (channel && connection) return channel;

        const url = process.env.RABBITMQ_URL || 'amqp://localhost';
        connection = await amqp.connect(url);
        channel = await connection.createChannel();

        // Handle connection errors
        connection.on('error', (err) => {
            console.error('[RabbitMQ] Connection error:', err.message);
            connection = null;
            channel = null;
        });
        
        connection.on('close', () => {
            console.warn('[RabbitMQ] Connection closed');
            connection = null;
            channel = null;
        });

        return channel;
    }

    /**
     * Dynamically assert an exchange, queue, and DLQ
     */
    static async setupQueue(queueName, routingKey, exchangeName = DEFAULT_EXCHANGE) {
        const ch = await this.getChannel();

        // Ensure main exchange + queue exist
        await ch.assertExchange(exchangeName, 'direct', { durable: true });
        await ch.assertQueue(queueName, {
            durable: true,
            arguments: {
                'x-dead-letter-exchange': `${exchangeName}.dlx`,
                'x-message-ttl': 86400000 // 24h TTL
            }
        });
        await ch.bindQueue(queueName, exchangeName, routingKey);

        // Setup Dead-letter exchange for failed messages
        await ch.assertExchange(`${exchangeName}.dlx`, 'direct', { durable: true });
        await ch.assertQueue(`${queueName}.failed`, { durable: true });
        await ch.bindQueue(`${queueName}.failed`, `${exchangeName}.dlx`, routingKey);

        return ch;
    }

    /**
     * Generic Publisher for ANY job type
     */
    static async publish(queueName, routingKey, payloadData, exchangeName = DEFAULT_EXCHANGE) {
        // Support two call signatures for convenience:
        // 1) publish(queueName, routingKey, payloadData, exchangeName)
        // 2) publish(routingKey, payloadData) -> queueName will be derived as `ziondefi.${routingKey}`
        let qName = queueName;
        let rKey = routingKey;
        let payload = payloadData;

        // Handle shorthand: publish(route, payload)
        if (typeof routingKey === 'object' && payloadData === undefined) {
            payload = routingKey;
            // routingKey was passed in as first arg
            if (typeof queueName === 'string') {
                // If caller passed a full queue name like 'ziondefi.agent.enable', derive route
                if (queueName.startsWith('ziondefi.')) {
                    qName = queueName;
                    rKey = queueName.replace(/^ziondefi\./, '');
                } else {
                    rKey = queueName;
                    qName = `ziondefi.${rKey}`;
                }
            }
        }

        const ch = await this.setupQueue(qName, rKey, exchangeName);

        const message = Buffer.from(JSON.stringify({
            data: payload,
            attempts: 0,
            max_attempts: MAX_RETRY_ATTEMPTS,
            created_at: Date.now()
        }));

        ch.publish(exchangeName, rKey, message, {
            persistent: true,
            contentType: 'application/json',
            messageId: (payload && payload.id) ? payload.id : Date.now().toString(),
            timestamp: Math.floor(Date.now() / 1000)
        });

        console.log(`[RabbitMQ] Published to ${rKey}`);
    }

    /**
     * Generic Consumer that accepts a custom handler function
     * @param {string} queueName - The queue to listen to
     * @param {string} routingKey - The routing key for setup
     * @param {Function} handler - The business logic function (must return a Promise)
     */
    static async consume(queueName, routingKey, handler, exchangeName = DEFAULT_EXCHANGE) {
        const ch = await this.setupQueue(queueName, routingKey, exchangeName);
        
        // Prefetch 1 to process one job at a time per consumer
        await ch.prefetch(1);
        console.log(`[RabbitMQ] Consumer started on queue: ${queueName}`);

        ch.consume(queueName, async (msg) => {
            if (!msg) return;

            let payload;
            try {
                payload = JSON.parse(msg.content.toString());
            } catch (e) {
                console.error(`[RabbitMQ] Invalid message format on ${queueName}:`, e.message);
                ch.nack(msg, false, false); // Send immediately to DLQ
                return;
            }

            const { data, attempts } = payload;
            const currentAttempt = (attempts || 0) + 1;

            try {
                await handler(data, currentAttempt, MAX_RETRY_ATTEMPTS);
                ch.ack(msg);
            } catch (err) {
                console.error(`[RabbitMQ] Job failed on ${queueName} (attempt ${currentAttempt}):`, err.message);

                if (currentAttempt < MAX_RETRY_ATTEMPTS) {
                    // Generic Exponential Backoff Retry
                    const delay = Math.min(1000 * Math.pow(2, currentAttempt), 60000); 
                    
                    setTimeout(async () => {
                        try {
                            const retryPayload = {
                                ...payload,
                                attempts: currentAttempt,
                                last_error: err.message,
                                retry_at: Date.now()
                            };
                            const retryMsg = Buffer.from(JSON.stringify(retryPayload));
                            
                            // Republish to the exact same route
                            ch.publish(msg.fields.exchange, msg.fields.routingKey, retryMsg, {
                                persistent: true,
                                contentType: 'application/json',
                                messageId: msg.properties.messageId
                            });
                        } catch (retryErr) {
                            console.error('[RabbitMQ] Retry publish failed:', retryErr.message);
                        }
                    }, delay);

                    // Ack the original so it isn't stuck blocking the queue, relying on the delayed republish
                    ch.ack(msg); 
                } else {
                    console.error(`[RabbitMQ] Job permanently failed on ${queueName} after ${MAX_RETRY_ATTEMPTS} attempts.`);
                    // Send to DLQ (because x-dead-letter is configured)
                    ch.nack(msg, false, false); 
                }
            }
        }, { noAck: false });
    }

    static async close() {
        try {
            if (channel) await channel.close();
            if (connection) await connection.close();
            channel = null;
            connection = null;
            console.log('[RabbitMQ] Connection closed gracefully');
        } catch (err) {
            console.error('[RabbitMQ] Close error:', err.message);
        }
    }
}

module.exports = RabbitService;