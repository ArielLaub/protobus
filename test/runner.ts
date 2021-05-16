require('source-map-support').install();

import * as Mocha from 'mocha';
import * as fs from 'fs';
import * as path from 'path';
import MessageFactory from '../lib/message_factory';
import Connection from '../lib/connection';
import MessageDispatcher from '../lib/message_dispatcher';
import EventDispatcher from '../lib/event_dispatcher';
import { Logger } from '../lib/logger';
import Config from '../lib/config';

process.on('unhandledRejection', (reason, p) => {
    console.error('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

async function run() {
    // Instantiate a Mocha instance.
    const mocha = new Mocha({
        bail: true,
        slow: 500,
        timeout: 20000
    });
    const testDir = './dist/test/';

    // Add each .js file to the mocha instance
    fs.readdirSync(testDir).filter(file => file.substr(-8) === '.test.js').forEach(file => {
        const testsFile = path.join(__dirname, file);
        Logger.info('adding file ' + testsFile);
        mocha.addFile(testsFile);
    });

    mocha.asyncOnly(true);

    // Run the tests.
    mocha.run(failures => {
        if (failures) {
            process.exit(failures);  // exit with non-zero status if there were failures
        } else {
            process.exit(0);
        }
    });
}

async function cleanup() {
}

async function setup() {
}

setup()
    .then(cleanup)
    .then(run);
