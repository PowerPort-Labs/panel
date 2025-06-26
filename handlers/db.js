const Keyv = require('keyv');
const db = new Keyv('sqlite://powerport.db');

module.exports = { db }