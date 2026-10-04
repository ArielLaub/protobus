import * as fs from 'fs';
import * as path from 'path';
import * as protoBuf from 'protobufjs';
import MessageFactory from '../message_factory';
import { loadConfig, resolvePath } from './config';
import { serviceNameConstant } from './generate-types';

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

    // Parse with the library's own loader, so imports, nested blocks, options
    // and the built-in custom types resolve exactly as they do at runtime.
    const services = servicesDeclaredIn(protoDir, protoFile);
    if (services.length === 0) {
        throw new Error(`${protoFile} declares no service`);
    }

    // Generate the service stub
    const serviceCode = generateServiceCode(services, typesOutput, path.join(servicesDir, serviceName.toLowerCase()));

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
 * The services a .proto file declares, loaded with every file under protoDir
 * so that the types they reference from other files resolve.
 *
 * This replaced a set of regular expressions that stopped at the first `}`
 * (an rpc's empty `{}` body dropped every method after it), matched only
 * single-segment names, and discarded the service's own name.
 */
function servicesDeclaredIn(protoDir: string, protoFile: string): protoBuf.Service[] {
    const factory = new MessageFactory();
    const log = console.log;
    console.log = () => undefined; // the loader narrates; a generator should not
    try {
        factory.init([protoDir]);
    } finally {
        console.log = log;
    }
    const target = path.resolve(protoFile);
    const found: protoBuf.Service[] = [];
    const walk = (ns: protoBuf.NamespaceBase) => {
        for (const child of ns.nestedArray) {
            if (child instanceof protoBuf.Service && child.filename && path.resolve(child.filename) === target) {
                found.push(child);
            }
            if (child instanceof protoBuf.Namespace || child instanceof protoBuf.Type) walk(child);
        }
    };
    walk((factory as any).root);
    return found;
}

/**
 * How the generated types name a message: its full name with the last segment
 * prefixed `I`, as pbts emits it (a nested message lives in its parent's
 * namespace). A type with no package is imported by name.
 */
function typeRef(type: protoBuf.ReflectionObject, roots: Set<string>): string {
    const parts = type.fullName.replace(/^\./, '').split('.');
    const name = `I${parts.pop()}`;
    roots.add(parts.length ? parts[0] : name);
    return parts.length ? `${parts.join('.')}.${name}` : name;
}

/**
 * Generate TypeScript service code: one RunnableService class per service.
 */
function generateServiceCode(services: protoBuf.Service[], typesOutput: string, serviceDir: string): string {
    // Calculate relative import path from service directory to types
    const relativeTypesPath = path.relative(serviceDir, typesOutput)
        .replace(/\.ts$/, '')
        .replace(/\\/g, '/'); // Normalize for Windows

    const roots = new Set<string>();
    const classNames: string[] = [];
    const classes = services.map(service => {
        const fullName = service.fullName.replace(/^\./, '');
        const pkg = fullName.slice(0, fullName.lastIndexOf('.'));
        const constant = pkg ? `${pkg}.${serviceNameConstant(service.name)}` : `'${fullName}'`;
        if (pkg) roots.add(pkg.split('.')[0]);
        // `service Service` keeps the established class name, <Package>Service.
        const className = service.name === 'Service' && pkg
            ? `${pkg.slice(pkg.lastIndexOf('.') + 1)}Service`
            : `${service.name}Service`;
        classNames.push(className);

        const methodStubs = service.methodsArray.map(method => {
            method.resolve();
            const req = typeRef(method.resolvedRequestType!, roots);
            const res = typeRef(method.resolvedResponseType!, roots);
            // A server-streaming method is an async generator: each `yield`
            // is one chunk to the caller.
            const signature = method.responseStream
                ? `async *${method.name}(request: ${req}): AsyncIterable<${res}>`
                : `async ${method.name}(request: ${req}): Promise<${res}>`;
            return `    ${signature} {
        // TODO: Implement ${method.name}
        throw new Error('Not implemented: ${method.name}');
    }`;
        }).join('\n\n');

        return `/**
 * ${fullName} implementation.
 *
 * Generated by protobus CLI. Implement the TODO methods below.
 */
export class ${className} extends RunnableService {
    public get ServiceName(): string {
        return ${constant};
    }

${methodStubs}
}`;
    });

    const starts = classNames.map(name => `        await RunnableService.start(context, ${name});`).join('\n');
    const typesImport = roots.size ? `import { ${[...roots].sort().join(', ')} } from '${relativeTypesPath}';\n` : '';

    return `import { RunnableService, Context } from 'protobus';
${typesImport}
${classes.join('\n\n')}

// Start the service when run directly
if (require.main === module) {
    (async () => {
        const context = new Context();
        await context.init(
            process.env.AMQP_URL || 'amqp://localhost',
            [process.env.PROTO_PATH || './proto']
        );

${starts}
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
