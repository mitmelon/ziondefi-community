const AuthController = require('../controllers/AuthController');
const { loginSchema, registerSchema } = require('../schemas/auth');

module.exports = async function (fastify, opts) {

    fastify.get('/', AuthController.showLogin);
    fastify.get('/index', AuthController.showLogin);
    fastify.get('/login', AuthController.showLogin);
    fastify.get('/logout', AuthController.logout);

    fastify.post('/login/wallet', { preHandler: fastify.csrfProtection }, AuthController.wallet);
};