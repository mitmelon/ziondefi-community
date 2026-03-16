const nodemailer = require('nodemailer');
const PostFilter = require('./PostFilter'); 
const path = require('path');

/**
 * EmailService
 * Handles SMTP and Sendmail transports using Nodemailer
 */
class EmailService {

    constructor(subject, to, text, from = '', replyTo = '', file = '') {
        // Sanitize Subject
        this.subject = PostFilter.strip(subject);
        
        this.to = Array.isArray(to) ? to : [to];
        this.body = text;
        
        this.from = from || process.env.SENDER_EMAIL;
        this.replyTo = replyTo || process.env.SENDER_EMAIL;
        this.appName = process.env.APP_NAME || 'ZionDefi';
        
        this.file = file;
        this.count = 0;
    }

    /**
     * Send via SMTP (Network)
     */
    async SMTP() {
        if (!this.to || this.to.length === 0) return false;

        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '587'),
            secure: parseInt(process.env.SMTP_PORT) === 465, // True for 465, false for other ports
            auth: {
                user: process.env.SMTP_USERNAME,
                pass: process.env.SMTP_PASSWORD
            },
            tls: {
                rejectUnauthorized: false 
            }
        });

        // Send to each recipient individually
        const promises = this.to.map(async (recipient) => {
            const mailOptions = {
                from: `"${this.appName}" <${this.from}>`,
                to: recipient,
                subject: this.subject,
                html: this.body,
                replyTo: this.replyTo,
                priority: 'high',
                headers: {
                    'X-Priority': '1',
                    'X-MSMail-Priority': 'High',
                    'Importance': 'High'
                }
            };

            // Handle Attachment
            if (this.file) {
                mailOptions.attachments = [{
                    filename: path.basename(this.file),
                    path: this.file
                }];
            }

            try {
                await transporter.sendMail(mailOptions);
                this.count++;
                return true;
            } catch (error) {
                console.error(`SMTP Send Error to ${recipient}:`, error.message);
                return false;
            }
        });

        await Promise.all(promises);

        return this.count > 0;
    }

    /**
     * Send via Native Sendmail (Local Binary)
     */
    async MAIL() {
        if (!this.to || this.to.length === 0) return false;

        // Create Sendmail Transport
        const transporter = nodemailer.createTransport({
            sendmail: true,
            newline: 'unix',
            path: '/usr/sbin/sendmail'
        });

        const promises = this.to.map(async (recipient) => {
            const mailOptions = {
                from: `"${this.appName}" <${this.from}>`,
                to: recipient,
                subject: this.subject,
                html: this.body,
                replyTo: this.replyTo,
                priority: 'high',
                headers: {
                    'Source': this.appName,
                    'X-Priority': '1'
                }
            };

            if (this.file) {
                mailOptions.attachments = [{
                    filename: path.basename(this.file),
                    path: this.file
                }];
            }

            try {
                await transporter.sendMail(mailOptions);
                this.count++;
                return true;
            } catch (error) {
                console.error(`Sendmail Error to ${recipient}:`, error.message);
                return false;
            }
        });

        await Promise.all(promises);

        return this.count > 0;
    }
}

module.exports = EmailService;