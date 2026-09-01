import { Context, ICustomType } from 'protobus';

const uuidType: ICustomType<string> = {
    name: 'uuid',           // how it is written in a .proto
    wireType: 'bytes',      // how it travels
    tsType: 'string',       // what generated types call it
    encode: (value: string) => Buffer.from(value.replace(/-/g, ''), 'hex'),
    decode: (data: Buffer) => {
        const hex = Buffer.from(data).toString('hex');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
};

async function main() {
    const context = new Context();

    // Register BEFORE init(): init() parses your .proto files, and a schema
    // using `uuid` cannot be parsed until the type exists.
    context.factory.registerType(uuidType);

    await context.init('amqp://localhost', ['./proto']);
}

main().catch((error) => { console.error(error); process.exit(1); });
