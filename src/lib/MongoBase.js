const EncryptionService = require('../services/EncryptionService');
const crypto = require('crypto');

class MongoBase extends EncryptionService {

    constructor(mongoClient, dbName, collectionName, indexes = {}) {
        super(null, 'master_key');

        this.client = mongoClient;
        this.dbname = dbName;
        this.collectionName = collectionName;
        
        this.db = this.client.db(dbName);
        this.collection = this.db.collection(collectionName);
        
        this.encryptionKeyName = null;
        this.encryptedFields = [];
        this.searchableFields = [];
        this.definedIndexes = indexes;
        this.indexesEnsured = false;
    }

    enableEncryption(encryptedFields, keyName, searchableFields = []) {
        if (!this.keyPairExists(keyName)) {
            if (!this.storeKeyPair(keyName)) throw new Error(`Failed to create key pair for ${keyName}`);
        }
        
        this.encryptionKeyName = keyName;
        this.encryptedFields = encryptedFields;
        this.searchableFields = searchableFields;
        return true;
    }

    selectCollection(collectionName) {
        this.collectionName = collectionName;
        this.collection = this.db.collection(collectionName);
        return this.collection;
    }

    getCollectionName() {
        return this.collectionName;
    }

    async insertOne(data, indexes) {
        if (indexes) this.definedIndexes = indexes;
        await this.ensureIndexes(!!indexes);

        const doc = await this.prepareDocumentForWrite(data);
        const result = await this.collection.insertOne(doc);
        
        return { 
            status: result.acknowledged ? 1 : 0, 
            id: result.insertedId 
        };
    }

    async insertMany(dataArray, indexes) {
        if (indexes) this.definedIndexes = indexes;
        await this.ensureIndexes(!!indexes);

        const docs = await Promise.all(dataArray.map(d => this.prepareDocumentForWrite(d)));
        const result = await this.collection.insertMany(docs);
        
        return { 
            status: result.insertedCount, 
            id: Object.values(result.insertedIds) 
        };
    }

    async update(type, query, updateData, options = {}) {
        await this.ensureIndexes();
        
        const safeQuery = this.transformQuery(query);
        let updateOp = {};

        const keys = Object.keys(updateData);
        const hasAtomicOperators = keys.some(k => k.startsWith('$'));

        if (hasAtomicOperators) {
            for (const [operator, payload] of Object.entries(updateData)) {
                if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
                    updateOp[operator] = await this.prepareDocumentForWrite(payload, true);
                } else {
                    updateOp[operator] = payload;
                }
            }
        } else {
            updateOp['$set'] = await this.prepareDocumentForWrite(updateData, true);
        }

        const result = await this.collection[type](safeQuery, updateOp, options);
        return result.modifiedCount;
    }

    async updateOne(query, update, options = {}) {
        return this.update('updateOne', query, update, options);
    }

    async updateMany(query, update, options = {}) {
        return this.update('updateMany', query, update, options);
    }

    async delete(type, query) {
        await this.ensureIndexes();
        const safeQuery = this.transformQuery(query);
        const result = await this.collection[type](safeQuery);
        return result.deletedCount;
    }

    async find(type, query = {}, options = {}) {
        await this.ensureIndexes();

        if (query.keyword && this.encryptionKeyName) {
            const token = this.generateKeywordToken(query.keyword, this.encryptionKeyName);
            const orConditions = this.encryptedFields.map(field => ({
                [`${field}_keywordTokens`]: token
            }));
            
            if (!query['$or']) query['$or'] = [];
            query['$or'] = query['$or'].concat(orConditions);
            delete query.keyword;
        }

        const safeQuery = this.transformQuery(query);

        if (type === 'findOne') {
            const doc = await this.collection.findOne(safeQuery, options);
            return await this.decryptOrRepairDocument(doc);
        } else {
            const cursor = this.collection.find(safeQuery, options);
            const docs = await cursor.toArray();
            return await Promise.all(docs.map(doc => this.decryptOrRepairDocument(doc)));
        }
    }

    async findOne(query = {}, options = {}) { return this.find('findOne', query, options); }
    async findAll(query = {}, options = {}) { return this.find('find', query, options); }
    
    async count(filter = {}, options = {}) {
        const safeFilter = this.transformQuery(filter);
        return await this.collection.countDocuments(safeFilter, options);
    }

    async distinct(field, filter = {}, options = {}) {
        const safeFilter = this.transformQuery(filter);
        const results = await this.collection.distinct(field, safeFilter, options);

        if (this.encryptionKeyName && this.encryptedFields.includes(field)) {
            return results.map(val => {
                const decrypted = this.decryptWithStoredKey(val, this.encryptionKeyName);
                return decrypted || val;
            });
        }
        return results;
    }

    async aggregate(pipeline, options = {}) {
        const safePipeline = pipeline.map(stage => {
            if (stage.$match) {
                return { ...stage, $match: this.transformQuery(stage.$match) };
            }
            return stage;
        });

        const cursor = this.collection.aggregate(safePipeline, options);
        const results = await cursor.toArray();
        return await Promise.all(results.map(doc => this.decryptOrRepairDocument(doc)));
    }

    async dropDatabase() {
        return await this.db.dropDatabase();
    }

    async createCollection(options = {}) {
        if (options.index) {
            this.definedIndexes = options.index;
            delete options.index;
        }

        if (!(await this.collectionExists(this.collectionName))) {
            await this.db.createCollection(this.collectionName, options);
        }
        
        await this.ensureIndexes(true);
        return { ok: 1 };
    }

    async dropCollection() {
        return await this.collection.drop();
    }

    async renameCollection(newName) {
        return await this.collection.rename(newName);
    }

    async listCollections() {
        return await this.db.listCollections().toArray();
    }

    async listDatabases() {
        const adminDb = this.client.db().admin();
        const result = await adminDb.listDatabases();
        return result.databases;
    }

    async collectionExists(name) {
        const collections = await this.db.listCollections({ name: name }, { nameOnly: true }).toArray();
        return collections.length > 0;
    }

    async create_index(keySpec, options = {}) {
        return await this.collection.createIndex(keySpec, options);
    }

    async list_index() {
        try {
            return await this.collection.indexes();
        } catch (e) {
            if (e.code === 26 || e.message.includes('ns does not exist')) return [];
            throw e;
        }
    }

    async drop_index(indexName) {
        try {
            return await this.collection.dropIndex(indexName);
        } catch (e) {
            return false;
        }
    }

    async find_index(indexName) {
        const indexes = await this.list_index();
        return indexes.find(idx => idx.name === indexName) || false;
    }

    buildDesiredIndexSpecs(definedIndexes = {}) {
        const specs = [];

        for (const [key, value] of Object.entries(definedIndexes || {})) {
            let options = {};
            let fieldName = key;
            let direction = 1;

            if (!isNaN(parseInt(key))) fieldName = value;

            if (value && typeof value === 'object') {
                if (value.unique) options.unique = true;
                if (value.sparse) options.sparse = true;
                if (typeof value.order === 'number') direction = value.order;
                if (typeof value.direction === 'number') direction = value.direction;
            } else if (value === true) {
                options.unique = true;
                options.sparse = true; 
            } else if (value === -1) {
                direction = -1;
            }

            if (fieldName) {
                options.name = fieldName;
                specs.push({ name: fieldName, key: { [fieldName]: direction }, options });
            }
        }
        return specs;
    }

    async syncIndexes(desiredIndexes = {}, force = false) {
        try {
            const desiredSpecs = this.buildDesiredIndexSpecs(desiredIndexes);

            if (this.encryptionKeyName && this.encryptedFields.length > 0) {
                for (const field of this.encryptedFields) {
                    const kwIndex = `${field}_keywordTokens`;
                    desiredSpecs.push({ name: kwIndex, key: { [kwIndex]: 1 }, options: { name: kwIndex } });

                    if (this.searchableFields.includes(field)) {
                        const hashIndex = `${field}_hash`;
                        desiredSpecs.push({ name: hashIndex, key: { [hashIndex]: 1 }, options: { name: hashIndex } });
                    }
                }
            }

            const existing = await this.list_index();
            const existingByName = {};
            for (const idx of existing) existingByName[idx.name] = idx;

            for (const spec of desiredSpecs) {
                if (!existingByName[spec.name]) {
                    await this.create_index(spec.key, spec.options || {});
                } else {
                    const existingKey = existingByName[spec.name].key || {};
                    const specKey = spec.key || {};
                    
                    if (JSON.stringify(existingKey) !== JSON.stringify(specKey) && spec.name !== '_id_') {
                        await this.drop_index(spec.name);
                        await this.create_index(spec.key, spec.options || {});
                    }
                }
            }

            for (const idx of existing) {
                if (idx.name === '_id_') continue;
                if (!desiredSpecs.find(s => s.name === idx.name)) {
                    await this.drop_index(idx.name);
                }
            }

            this.indexesEnsured = true;
        } catch (e) {
            console.error('Index sync warning:', e.message);
        }
    }

    async ensureIndexes(force = false) {
        if (this.indexesEnsured && !force) return;
        await this.syncIndexes(this.definedIndexes || {}, force);
    }

    async prepareDocumentForWrite(data, isUpdate = false) {
        const doc = { ...data };
        if (!this.encryptionKeyName || !this.encryptedFields.length) return doc;

        for (const field of this.encryptedFields) {
            if (doc[field] === undefined || doc[field] === null) continue;
            
            let original = doc[field];
            if (this.isAlreadyEncrypted(original)) {
                if (isUpdate) {
                    delete doc[`${field}_hash`];
                    delete doc[`${field}_keywordTokens`];
                }
                continue;
            }

            let valueToEncrypt = typeof original === 'string' ? original : JSON.stringify(original);
            const encrypted = this.encryptWithStoredKey(valueToEncrypt, this.encryptionKeyName);
            
            if (encrypted) {
                doc[field] = encrypted;
                if (this.searchableFields.includes(field)) {
                    doc[`${field}_hash`] = this.generateSearchHash(valueToEncrypt, this.encryptionKeyName);
                }
                if (typeof valueToEncrypt === 'string' && valueToEncrypt.length > 10) {
                    const keywords = this.extractKeywords(valueToEncrypt);
                    doc[`${field}_keywordTokens`] = keywords.map(kw => 
                        this.generateKeywordToken(kw, this.encryptionKeyName)
                    );
                }
            }
        }
        return doc;
    }

    async decryptOrRepairDocument(doc) {
        if (!doc || !this.encryptionKeyName) return doc;

        const cleanDoc = { ...doc };
        for (const field of this.encryptedFields) {
            if (cleanDoc[field] === undefined) continue;

            const stored = cleanDoc[field];
            const decrypted = this.decryptWithStoredKey(stored, this.encryptionKeyName);
            
            if (decrypted) {
                try { cleanDoc[field] = JSON.parse(decrypted); } catch { cleanDoc[field] = decrypted; }
                continue;
            }

            if (!this.isAlreadyEncrypted(stored)) {
                try {
                    const val = typeof stored === 'string' ? stored : JSON.stringify(stored);
                    const enc = this.encryptWithStoredKey(val, this.encryptionKeyName);
                    
                    if (enc) {
                        const update = { [field]: enc };
                        if (this.searchableFields.includes(field)) {
                            update[`${field}_hash`] = this.generateSearchHash(val, this.encryptionKeyName);
                        }
                        if (doc._id) await this.collection.updateOne({ _id: doc._id }, { $set: update });
                    }
                } catch (err) {}
            }
        }

        this.searchableFields.forEach(f => delete cleanDoc[`${f}_hash`]);
        this.encryptedFields.forEach(f => delete cleanDoc[`${f}_keywordTokens`]);
        return cleanDoc;
    }

    transformQuery(query) {
        if (!this.encryptionKeyName) return query;
        
        const newQuery = {};
        for (const [key, value] of Object.entries(query)) {
            if (['$or', '$and', '$nor'].includes(key) && Array.isArray(value)) {
                newQuery[key] = value.map(item => this.transformQuery(item));
                continue;
            }

            if (this.searchableFields.includes(key) && typeof value === 'string') {
                newQuery[`${key}_hash`] = this.generateSearchHash(value, this.encryptionKeyName);
            } else {
                newQuery[key] = value;
            }
        }
        return newQuery;
    }

    isAlreadyEncrypted(value) {
        if (typeof value !== 'string') return false;
        if (value.length < 40) return false;
        return /^[A-Za-z0-9+/=]+$/.test(value);
    }

    extractKeywords(text) {
        return text.toLowerCase().split(' ').filter(w => w.length > 3);
    }

    generateSearchHash(value, keyName) {
        const tokenKey = this.getTokenKey(keyName);
        if (!tokenKey) throw new Error("Token Key Missing");
        return crypto.createHmac('sha256', Buffer.from(tokenKey, 'base64'))
            .update(String(value).toLowerCase().trim()).digest('hex');
    }

    generateKeywordToken(keyword, keyName) {
        const tokenKey = this.getTokenKey(keyName);
        if (!tokenKey) throw new Error("Token Key Missing");
        return crypto.createHmac('sha256', Buffer.from(tokenKey, 'base64'))
            .update(keyword.toLowerCase()).digest('hex');
    }

    useDatabase(newDbName) {
        this.dbname = newDbName;
        this.db = this.client.db(newDbName);
        this.collection = this.db.collection(this.collectionName);
        
        return this;
    }
}

module.exports = MongoBase;