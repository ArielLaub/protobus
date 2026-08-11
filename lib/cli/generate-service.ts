import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, resolvePath } from './config';

interface RpcMethod {
    name: string;
    requestType: string;
    responseType: string;
}

interface ParsedService {
    packageName: string;
    serviceName: string;
    methods: RpcMethod[];
}

/** Raised when a service name could not be used safely in a file path. */
export class InvalidServiceNameError extends Error {
    constructor(name: string, reason: string) {
        super(`invalid service name ${JSON.stringify(name)}: ${reason}`);
        this.name = 'InvalidServiceNameError';
    }
}

/**
 * Validate a service name before it is interpolated into a filesystem path.
 *
 * The name arrives from argv and is joined onto the configured proto and
 * services directories, so anything containing a separator or a `..` segment
 * writes outside them. Rather than sanitising — which invites disagreement
 * between what was asked for and what was written — reject and say why.
 *
 * @returns the name unchanged, so call sites can use it inline.
 */
export function assertSafeServiceName(name: string): string {
    if (typeof name !== 'string' || name.length === 0) {
        throw new InvalidServiceNameError(String(name), 'must be a non-empty string');
    }
    if (name.length > 100) {
        throw new InvalidServiceNameError(name, 'must be 100 characters or fewer');
    }
    // A single conservative rule: identifier characters only. This excludes
    // path separators, `..`, null bytes, whitespace and drive letters in one
    // step, rather than trying to enumerate what to forbid.
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new InvalidServiceNameError(
            name, 'may contain only letters, digits, underscore and hyphen',
        );
    }
    if (name === '.' || name === '..') {
        throw new InvalidServiceNameError(name, 'is a path segment, not a name');
    }
    return name;
}

/**
 * Generate a service stub from a .proto file.
 *
 * @param serviceName - The service name (e.g., "Calculator" will look for Calculator.proto)
 * @param cwd - Working directory
 */
export async function generateService(serviceName: string, cwd: string = process.cwd()): Promise<void> {
    // Reusable functions throw; only the command wrapper at the bottom of this
    // file decides the process should die. Calling process.exit() from here
    // made this impossible to call from a script, a test, or another tool.
    assertSafeServiceName(serviceName);

    const config = loadConfig(cwd);
    const protoDir = resolvePath(config.protoDir, cwd);
    const servicesDir = resolvePath(config.servicesDir, cwd);
    const typesOutput = resolvePath(config.typesOutput, cwd);

    // Find the proto file
    const protoFile = path.join(protoDir, `${serviceName}.proto`);
    if (!fs.existsSync(protoFile)) {
        throw new Error(`Proto file not found: ${protoFile}`);
    }

    // Parse the proto file
    const protoContent = fs.readFileSync(protoFile, 'utf-8');
    const parsed = parseProtoFile(protoContent, serviceName);

    if (!parsed) {
        throw new Error(`Could not find service definition in ${protoFile}`);
    }

    // Generate the service stub
    const serviceCode = generateServiceCode(parsed, typesOutput, servicesDir);

    // Create output directory
    const serviceDir = path.join(servicesDir, serviceName.toLowerCase());
    if (!fs.existsSync(serviceDir)) {
        fs.mkdirSync(serviceDir, { recursive: true });
    }

    // Write the service file
    const outputFile = path.join(serviceDir, `${serviceName}Service.ts`);

    if (fs.existsSync(outputFile)) {
        throw new Error(
            `Service file already exists: ${outputFile}. Remove it first if you want to regenerate.`,
        );
    }

    fs.writeFileSync(outputFile, serviceCode);
    console.log(`Service generated: ${outputFile}`);
}

/**
 * Parse a .proto file to extract service information
 */
function parseProtoFile(content: string, expectedPackage: string): ParsedService | null {
    // Extract package name
    const packageMatch = content.match(/package\s+(\w+)\s*;/);
    const packageName = packageMatch ? packageMatch[1] : expectedPackage;

    // Extract service definition
    const serviceMatch = content.match(/service\s+(\w+)\s*\{([^}]+)\}/s);
    if (!serviceMatch) {
        return null;
    }

    const serviceName = serviceMatch[1];
    const serviceBody = serviceMatch[2];

    // Extract RPC methods
    const methods: RpcMethod[] = [];
    const rpcRegex = /rpc\s+(\w+)\s*\(\s*(\w+)\s*\)\s*returns\s*\(\s*(\w+)\s*\)/g;
    let match;

    while ((match = rpcRegex.exec(serviceBody)) !== null) {
        methods.push({
            name: match[1],
            requestType: match[2],
            responseType: match[3],
        });
    }

    return {
        packageName,
        serviceName,
        methods,
    };
}

/**
 * Generate TypeScript service code
 */
function generateServiceCode(parsed: ParsedService, typesOutput: string, servicesDir: string): string {
    const { packageName, methods } = parsed;

    // Calculate relative import path from service directory to types
    const serviceSubDir = path.join(servicesDir, packageName.toLowerCase());
    const relativeTypesPath = path.relative(serviceSubDir, typesOutput)
        .replace(/\.ts$/, '')
        .replace(/\\/g, '/'); // Normalize for Windows

    // Generate method stubs
    const methodStubs = methods.map(method => {
        const requestParam = `request: ${packageName}.I${method.requestType}`;
        const returnType = `Promise<${packageName}.I${method.responseType}>`;

        return `    async ${method.name}(${requestParam}): ${returnType} {
        // TODO: Implement ${method.name}
        throw new Error('Not implemented: ${method.name}');
    }`;
    }).join('\n\n');

    return `import { RunnableService, Context } from 'protobus';
import { ${packageName} } from '${relativeTypesPath}';

/**
 * ${packageName} Service Implementation
 *
 * Generated by protobus CLI. Implement the TODO methods below.
 */
export class ${packageName}Service extends RunnableService implements ${packageName}.Service {
    ServiceName = ${packageName}.ServiceName;

${methodStubs}
}

// Start the service when run directly
if (require.main === module) {
    (async () => {
        const context = new Context();
        await context.init(
            process.env.AMQP_URL || 'amqp://localhost',
            [process.env.PROTO_PATH || './proto']
        );

        await RunnableService.start(context, ${packageName}Service);
    })();
}
`;
}

// Allow running directly
if (require.main === module) {
    const serviceName = process.argv[2];
    if (!serviceName) {
        console.error('Usage: generate-service <ServiceName>');
        console.error('Example: generate-service Calculator');
        process.exit(1);
    }

    generateService(serviceName).catch(err => {
        console.error('Error generating service:', err);
        process.exit(1);
    });
}
