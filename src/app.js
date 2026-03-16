const fastify = require('fastify');
const path = require('path');
const AutoLoad = require('@fastify/autoload');
const mongo = require('@fastify/mongodb');
const view = require('@fastify/view');
const ejs = require('ejs');
const csrf = require('@fastify/csrf-protection');
const PostFilter = require('./services/PostFilter');

const dictionary = {
    en: require('./locales/en.json')
};

function buildApp(opts = {}) {
    const isProd = process.env.NODE_ENV === 'production';
    const app = fastify(opts);

    // --- CORE PLUGINS ---
    app.register(mongo, {
        forceClose: true,
        url: process.env.MONGO_URI,
        database: process.env.MONGO_DB,
    });
    app.register(require('@fastify/formbody'));
    app.register(require('@fastify/multipart'), { attachFieldsToBody: 'keyValues' });
    app.register(require('@fastify/cookie'), {
        secret: process.env.COOKIE_SECRET,
        parseOptions: {}
    });
    
    // --- CSRF PROTECTION ---
    app.register(csrf, {
        sessionPlugin: '@fastify/cookie',
        cookieOpts: { signed: true, httpOnly: true, path: '/', secure: isProd }
    });

    // --- ASSETS & VIEWS ---
    app.register(require('@fastify/static'), {
        root: path.join(__dirname, '../public'),
        prefix: '/public/',
    });
    
    app.register(view, {
        engine: { ejs: ejs },
        root: path.join(__dirname, 'views'),
        includeViewExtension: true,
        options: { filename: path.resolve('src/views') }
    });
    
    app.register(require('@fastify/helmet'), { 
        global: true, 
        contentSecurityPolicy: false // Allow inline scripts for now
    });

    // --- GLOBAL HOOKS ---
    app.decorateRequest('postFilter', null);
    app.addHook('onRequest', async (req, reply) => {
        req.postFilter = PostFilter;
    });

    app.addHook('preHandler', async (req, reply) => {
        reply.locals = reply.locals || {};

        let lang = req.cookies.lang || 'en';
        if (!dictionary[lang]) lang = 'en';

        const t = function(key, args = {}) {
            const parts = key.split('.');
            let text = dictionary[lang];
            for (const part of parts) {
                text = text ? text[part] : undefined;
            }

            if (!text) return key; 
            if (args) {
                for (const [varKey, varValue] of Object.entries(args)) {
                    // Replace all occurrences
                    text = text.split(`%{${varKey}}`).join(varValue);
                }
            }
            return text;
        };
        
        req.t = t;
        reply.locals.t = t;
        reply.locals.locale = lang;

        // CSRF Token Logic
        if (req.method === 'GET' && !req.url.startsWith('/public')) {
            const token = await reply.generateCsrf();
            reply.locals.csrfToken = token;
        }
        
        reply.locals.user = req.user || null;
    });
   
    app.register(require('./plugins/models'));
    app.register(require('./plugins/auth-guard'));

    app.setNotFoundHandler((req, reply) => {
        req.log.info(`404 Not Found: ${req.method} ${req.url}`);
        return reply.status(404).view('errors/404.ejs', {
            title: 'Page Not Found',
        });
    });

    app.setErrorHandler((error, req, reply) => {
        req.log.error(error);

        if (error.validation) {
            return reply.status(400).send({
                status: 400,
                error: error.message
            });
        }

        if (req.headers['content-type'] === 'application/json' || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            return reply.status(error.statusCode || 500).send({
                status: error.statusCode || 500,
                error: process.env.NODE_ENV === 'development' ? error.message : 'Server Error'
            });
        }

        if (reply.statusCode === 404) {
            return reply.view('errors/404.ejs', { title: 'Not Found', user: req.user });
        }

        return reply.status(500).view('errors/500.ejs', {
            title: 'Server Error',
            message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong.'
        });
    });
    
    app.register(AutoLoad, {
        dir: path.join(__dirname, 'routes'),
        options: { prefix: '/' }
    });

    return app;
}

module.exports = buildApp;