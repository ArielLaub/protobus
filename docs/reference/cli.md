# Protobus CLI

The protobus CLI provides tools for generating TypeScript types from Protocol Buffer definitions and scaffolding service implementations.

## Installation

The CLI is included with protobus - no extra installation needed. However, you'll need `protobufjs-cli` as a dev dependency for type generation:

```bash
npm install protobus
npm install --save-dev protobufjs-cli
```

## Commands

### `protobus generate`

Generates TypeScript types from all `.proto` files in your proto directory.

```bash
npx protobus generate
```

**What it does:**
1. Finds all `.proto` files in your configured `protoDir`
2. Uses `protobufjs-cli` to generate TypeScript definitions
3. Transforms the output to be more ergonomic for protobus:
   - Adds `ServiceName` constants to each service namespace
   - Exports all interfaces, enums, and types
   - Converts service classes to interfaces

**Output example:**

Given `proto/Calculator.proto`:
```protobuf
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
```

Generates `common/types/proto.ts`:
```typescript
export namespace Calculator {
    export const ServiceName = 'Calculator.Service' as const;

    export interface Service {
        add(request: Calculator.IAddRequest): Promise<Calculator.IAddResponse>;
    }

    export interface IAddRequest {
        a?: number;
        b?: number;
    }

    export interface IAddResponse {
        result?: number;
    }
}
```

### `protobus generate:service <Name>`

Generates a service stub that implements all RPC methods from a `.proto` file.

```bash
npx protobus generate:service Calculator
```

**What it does:**
1. Reads `<Name>.proto` from your `protoDir`
2. Parses the service definition and RPC methods
3. Generates a TypeScript class extending `RunnableService`
4. Creates the file in `servicesDir/<name>/<Name>Service.ts`

**Output example:**

Generates `services/calculator/CalculatorService.ts`:
```typescript
import { RunnableService, Context } from 'protobus';
import { Calculator } from '../../common/types/proto';

export class CalculatorService extends RunnableService implements Calculator.Service {
    ServiceName = Calculator.ServiceName;

    async add(request: Calculator.IAddRequest): Promise<Calculator.IAddResponse> {
        // TODO: Implement add
        throw new Error('Not implemented: add');
    }
}

// Start the service when run directly
if (require.main === module) {
    (async () => {
        const context = new Context();
        await context.init(
            process.env.AMQP_URL || 'amqp://localhost',
            [process.env.PROTO_PATH || './proto']
        );

        await RunnableService.start(context, CalculatorService);
    })();
}
```

### `protobus init`

Displays setup instructions for a new protobus project.

```bash
npx protobus init
```

## Configuration

Configure the CLI by adding a `protobus` section to your `package.json`:

```json
{
  "protobus": {
    "protoDir": "./proto",
    "typesOutput": "./common/types/proto.ts",
    "servicesDir": "./services"
  }
}
```

### Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `protoDir` | `./proto` | Directory containing `.proto` files |
| `typesOutput` | `./common/types/proto.ts` | Output path for generated TypeScript types |
| `servicesDir` | `./services` | Directory for generated service stubs |

## Recommended package.json Scripts

```json
{
  "scripts": {
    "proto:types": "protobus generate",
    "proto:service": "protobus generate:service",
    "build": "npm run proto:types && tsc"
  }
}
```

## Project Structure

The CLI expects and generates the following structure:

```
my-project/
├── proto/                      # .proto files
│   ├── Calculator.proto
│   └── Notifications.proto
├── common/
│   └── types/
│       └── proto.ts            # Generated types (by protobus generate)
├── services/
│   ├── calculator/
│   │   └── CalculatorService.ts    # Generated stub (by protobus generate:service)
│   └── notifications/
│       └── NotificationsService.ts
├── package.json
└── docker-compose.yml
```

## Workflow

The typical development workflow with the CLI:

1. **Create a proto file:**
   ```bash
   vim proto/Calculator.proto
   ```

2. **Generate TypeScript types:**
   ```bash
   npm run proto:types
   ```

3. **Generate service stub:**
   ```bash
   npx protobus generate:service Calculator
   ```

4. **Implement the service:**
   Open `services/calculator/CalculatorService.ts` and implement the TODO methods.

5. **Run the service:**
   ```bash
   ts-node services/calculator/CalculatorService.ts
   ```

## Tips

- Run `proto:types` as part of your build script to ensure types are always up-to-date
- The service generator will not overwrite existing files - delete the file first if you want to regenerate
- Use the `ServiceName` constant instead of hardcoding strings: `Calculator.ServiceName` instead of `'Calculator.Service'`
