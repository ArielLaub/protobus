import MessageFactory from '../../lib/message_factory';
import { BigIntType, TimestampType, ICustomType, getCustomType } from '../../lib/custom_types';

/**
 * Registering a custom type twice must not throw.
 *
 * The built-ins are registered at import time, so `registerType(BigIntType)` —
 * the exact line the README shows for custom types — hit protobufjs's
 * decorated root a second time and threw `duplicate name`. So did any process
 * that constructed two MessageFactories, or re-registered its own type on a
 * reload. There is no way for a caller to ask whether a name is taken before
 * trying, which made the throw unavoidable rather than merely inconvenient.
 */
describe('MessageFactory.registerType is idempotent', () => {
    it('re-registering a built-in does not throw', () => {
        const factory = new MessageFactory();
        factory.init([]);
        expect(() => factory.registerType(BigIntType)).not.toThrow();
        expect(() => factory.registerType(TimestampType)).not.toThrow();
    });

    it('returns the same message class for the same name', () => {
        const factory = new MessageFactory();
        factory.init([]);
        const first = factory.registerType(BigIntType);
        const second = factory.registerType(BigIntType);
        expect(second).toBe(first);
    });

    it('a second factory can register the same custom type, and neither loses anything', () => {
        const uuid: ICustomType<string> = {
            name: 'idem_uuid',
            wireType: 'bytes',
            tsType: 'string',
            encode: (v: string) => Buffer.from(v.replace(/-/g, ''), 'hex'),
            decode: (d: Buffer) => d.toString('hex'),
        };
        const a = new MessageFactory();
        a.init([]);
        a.registerType(uuid);

        const b = new MessageFactory();
        b.init([]);
        expect(() => b.registerType(uuid)).not.toThrow();

        // Not just "did not throw". protobufjs's Namespace.add REPARENTS, so
        // the second factory can quietly take a type out of the first one's
        // root — which is exactly what the built-ins used to suffer, and what
        // a bare not.toThrow() here failed to catch.
        expect(a.hasType('idem_uuid')).toBe(true);
        expect(b.hasType('idem_uuid')).toBe(true);
        expect(a.hasType('bigint')).toBe(true);
        expect(a.hasType('timestamp')).toBe(true);
    });

    it('a later registration still replaces the codec', () => {
        const name = 'idem_codec';
        const first: ICustomType<string> = {
            name, wireType: 'string', tsType: 'string',
            encode: (v: string) => `first:${v}`,
            decode: (d: string) => `first:${d}`,
        };
        const second: ICustomType<string> = {
            name, wireType: 'string', tsType: 'string',
            encode: (v: string) => `second:${v}`,
            decode: (d: string) => `second:${d}`,
        };
        const factory = new MessageFactory();
        factory.init([]);
        factory.registerType(first);
        factory.registerType(second);
        expect(getCustomType(name)!.encode('x')).toBe('second:x');
    });

    it('refuses a re-registration that changes the wire type', () => {
        const name = 'idem_conflict';
        const asBytes: ICustomType<string> = {
            name, wireType: 'bytes', tsType: 'string',
            encode: (v: string) => Buffer.from(v), decode: (d: Buffer) => d.toString(),
        };
        const asString: ICustomType<string> = {
            name, wireType: 'string', tsType: 'string',
            encode: (v: string) => v, decode: (d: string) => d,
        };
        const factory = new MessageFactory();
        factory.init([]);
        factory.registerType(asBytes);
        // The generated protobuf message is fixed at first registration, so
        // silently accepting a different wireType would keep encoding on the
        // wire format of the FIRST one. That must fail loudly, not quietly.
        expect(() => factory.registerType(asString)).toThrow(/wire type/i);
    });
});
