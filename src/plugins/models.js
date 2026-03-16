const fp = require('fastify-plugin');
const User = require('../models/User');
const Session = require('../models/Session');
const Security = require('../models/Security');
const Notification = require('../models/Notification');
const ApiClient = require('../models/ApiClient');
const ApiToken = require('../models/ApiToken');
const Transactions = require('../models/Transactions');
const Cards = require('../models/Cards');
const Bridge = require('../models/Bridge');
const Agent = require('../models/Agent');
const AgentLogs = require('../models/AgentLogs');
const StakePosition = require('../models/StakePosition');
const ApiService = require('../services/ApiService');
const AuthService = require('../services/AuthService');
const DashboardService = require('../services/DashboardService');

async function modelPlugin(fastify, options) {
    const client = fastify.mongo.client;

    fastify.decorateRequest('models', null);
    fastify.decorateRequest('auth', null);
    fastify.decorateRequest('dashboard', null);
    fastify.decorateRequest('apiService', null);
    fastify.decorateRequest('transactions', null);
    fastify.decorateRequest('cards', null);
    fastify.decorateRequest('bridge', null);
    fastify.decorateRequest('agent', null);
    fastify.decorateRequest('agentLogs', null);
    fastify.decorateRequest('stakePosition', null);

    fastify.addHook('onRequest', async (req, reply) => {
        req.models = {
            User: new User(client),
            Session: new Session(client),
            Security: new Security(client),
            Notification: new Notification(client),
            ApiClient: new ApiClient(client),
            ApiToken: new ApiToken(client),
            Transactions: new Transactions(client),
            Cards: new Cards(client),
            Bridge: new Bridge(client),
            Agent: new Agent(client),
            AgentLogs: new AgentLogs(client),
            StakePosition: new StakePosition(client),
        };

        req.auth = new AuthService(req.models); 
        req.dashboard = new DashboardService(req.models);
        req.apiService = new ApiService(req.models);
        req.transactions = new Transactions(client);
        req.cards = new Cards(client);
        req.bridge = new Bridge(client);
        req.agent = new Agent(client);
        req.agentLogs = new AgentLogs(client);
        req.stakePosition = new StakePosition(client);
    });
}

module.exports = fp(modelPlugin);