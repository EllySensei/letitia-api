require('dotenv').config();
const express = require('express');
const mariadb = require('mariadb');
const { initDatabase } = require('./db_init');

const app = express();
const port = 3000;

const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
};

let pool;

app.get('/', (req, res) => {
    res.send('Hello world!');
})

async function start() {
    try {
        await initDatabase(dbConfig);
    } catch (err) {
        console.error('Error initializing database:', err.message);
        process.exit(1);
    }

    // Created after init so the pool's default database is guaranteed to exist.
    pool = mariadb.createPool({ ...dbConfig, connectionLimit: 5 });

    app.listen(port, () => {
        console.log(`Server is online on PORT ${port}`);
    })
}

start();
