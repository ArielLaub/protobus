import { Context, ICustomType } from 'protobus';

const UuidType: ICustomType<string> = {
    name: 'uuid',                 // how it is written in the .proto
    wireType: 'string',           // how it travels
    tsType: 'string',             // what generated types call it
    encode: (value: string) => value,
    decode: (data: string) => data,
};

async function main() {
    const context = new Context();

    // Register before init(): init() parses your .proto files, and a schema
    // using `uuid` cannot be parsed until the type exists.
    context.factory.registerType(UuidType);

    await context.init('amqp://localhost', ['./proto']);
}
