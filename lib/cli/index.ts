#!/usr/bin/env node

import { generateTypes } from './generate-types';
import { generateService } from './generate-service';

const VERSION = require('../../../package.json').version;

const HELP = `
protobus CLI v${VERSION}

Usage:
  protobus generate              Generate TypeScript types from .proto files
  protobus generate:service <Name>  Generate a service stub from a .proto file
  protobus init                  Show project setup instructions
  protobus --help                Show this help message
  protobus --version             Show version

Configuration:
  Add a "protobus" section to your package.json to customize paths:

  {
    "protobus": {
      "protoDir": "./proto",
      "typesOutput": "./common/types/proto.ts",
      "servicesDir": "./services"
    }
  }

Examples:
  # Generate types from all .proto files
  npx protobus generate

  # Generate a service stub for Calculator.proto
  npx protobus generate:service Calculator
`;

const INIT_INSTRUCTIONS = `
Protobus Project Setup
======================

1. Create the directory structure:

   mkdir -p proto common/types services

2. Add configuration to your package.json:

   {
     "scripts": {
       "proto:types": "protobus generate",
       "proto:service": "protobus generate:service",
       "build": "npm run proto:types && tsc"
     },
     "protobus": {
       "protoDir": "./proto",
       "typesOutput": "./common/types/proto.ts",
       "servicesDir": "./services"
     }
   }

3. Install dev dependencies:

   npm install --save-dev protobufjs-cli typescript

4. Create your first .proto file in proto/Calculator.proto:

   syntax = "proto3";
   package Calculator;

   service Service {
     rpc add(AddRequest) returns (AddResponse);
   }

   message AddRequest {
     int32 a = 1;
     int32 b = 2;
   }

   message AddResponse {
     int32 result = 1;
   }

5. Generate types and service:

   npm run proto:types
   npx protobus generate:service Calculator

6. Implement your service in services/calculator/CalculatorService.ts

7. Set up RabbitMQ (docker-compose.yml):

   services:
     rabbitmq:
       image: rabbitmq:3-management
       ports:
         - "5672:5672"
         - "15672:15672"

For more information, see: https://github.com/ArielLaub/protobus
`;

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    if (!command || command === '--help' || command === '-h') {
        console.log(HELP);
        process.exit(0);
    }

    if (command === '--version' || command === '-v') {
        console.log(VERSION);
        process.exit(0);
    }

    if (command === 'init') {
        console.log(INIT_INSTRUCTIONS);
        process.exit(0);
    }

    if (command === 'generate') {
        await generateTypes();
        process.exit(0);
    }

    if (command === 'generate:service') {
        const serviceName = args[1];
        if (!serviceName) {
            console.error('Error: Service name required');
            console.error('Usage: protobus generate:service <ServiceName>');
            console.error('Example: protobus generate:service Calculator');
            process.exit(1);
        }
        await generateService(serviceName);
        process.exit(0);
    }

    // Unknown command
    console.error(`Unknown command: ${command}`);
    console.error('Run "protobus --help" for usage information');
    process.exit(1);
}

main().catch(err => {
    console.error('Error:', err.message || err);
    process.exit(1);
});
