const { MongoClient } = require('mongodb');
const startAllWorkers = require('./src/workers/index');

async function bootstrapWorkers() {
    const mongoClient = await MongoClient.connect(process.env.MONGO_URI);
    console.log('Worker Process: Connected to MongoDB');

    await startAllWorkers(mongoClient);
}

bootstrapWorkers();