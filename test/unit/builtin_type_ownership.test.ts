import MessageFactory from '../../lib/message_factory';
import { BigIntType, ICustomType } from '../../lib/custom_types';

/**
 * One factory's root must not be able to steal a built-in type out of
 * another's.
 *
 * `BigIntMessage.$type` and `TimestampMessage.$type` are module-level
 * singletons, and protobufjs's `Namespace.add` REPARENTS: it removes the
 * object from its previous parent. So the second `MessageFactory.init()` in a
 * process used to take `bigint` and `timestamp` out of the first factory's
 * root, leaving it with an empty slot where a built-in should be.
 *
 * Schemas the first factory had already parsed kept working, because
 * protobufjs resolves fields eagerly — which is what made this so quiet.
 * Anything parsed into it AFTERWARDS died at encode time with
 * `no such Type or Enum 'bigint'`, in a factory that had never done anything
 * wrong. Two Contexts in one process is all it takes: a gateway bridging two
 * vhosts, a test harness, a service rebuilding its context.
 *
 * Fixed by giving each root its own copy of the built-ins, so there is nothing
 * shared left to reparent.
 */

const schemaUsing = (pkg: string) => `syntax = "proto3";
package ${pkg};

message Amount { bigint value = 1; }
message Ack { bool ok = 1; }

service Wallet {
    rpc credit(${pkg}.Amount) returns(${pkg}.Ack);
}`;

describe('built-in custom types are owned per factory', () => {
    it('a second factory init does not remove them from the first', () => {
        const a = new MessageFactory();
        a.init([]);
        expect(a.hasType('bigint')).toBe(true);
        expect(a.hasType('timestamp')).toBe(true);

        const b = new MessageFactory();
        b.init([]);

        expect(a.hasType('bigint')).toBe(true);
        expect(a.hasType('timestamp')).toBe(true);
        expect(b.hasType('bigint')).toBe(true);
        expect(b.hasType('timestamp')).toBe(true);
    });

    it('the first factory can still parse and ENCODE a schema using bigint afterwards', () => {
        // The assertion that matters: `hasType` alone would pass on a root
        // holding a broken type. This is the failure users actually saw.
        const a = new MessageFactory();
        a.init([]);

        const b = new MessageFactory();
        b.init([]);

        a.parse(schemaUsing('OwnA'), 'OwnA.Wallet');
        const buffer = a.buildRequest('OwnA.Wallet.credit', { value: 42n }, 'actor');
        expect(Buffer.isBuffer(buffer)).toBe(true);

        const envelope = a.decodeRequestEnvelope(buffer);
        expect(a.decodeRequestPayload(envelope.method, envelope.data as any))
            .toMatchObject({ value: 42n });
    });

    it('both factories can encode against their own copy independently', () => {
        const a = new MessageFactory();
        a.init([]);
        const b = new MessageFactory();
        b.init([]);

        a.parse(schemaUsing('OwnB1'), 'OwnB1.Wallet');
        b.parse(schemaUsing('OwnB2'), 'OwnB2.Wallet');

        expect(() => a.buildRequest('OwnB1.Wallet.credit', { value: 7n }, 'x')).not.toThrow();
        expect(() => b.buildRequest('OwnB2.Wallet.credit', { value: 9n }, 'x')).not.toThrow();
    });

    it('registerType never reports success while leaving the root without the type', () => {
        // registerType returns a message class; the caller's only signal that
        // the type is usable is that it did not throw. That signal has to mean
        // the ROOT holds it, not merely that a bookkeeping map does.
        const a = new MessageFactory();
        a.init([]);
        const b = new MessageFactory();
        b.init([]);

        a.registerType(BigIntType);
        expect(a.hasType('bigint')).toBe(true);
    });

    it('holds for a user-defined type registered on two factories', () => {
        const money: ICustomType<string> = {
            name: 'own_money', wireType: 'string', tsType: 'string',
            encode: (v: string) => v, decode: (d: string) => d,
        };
        const a = new MessageFactory();
        a.init([]);
        a.registerType(money);

        const b = new MessageFactory();
        b.init([]);
        b.registerType(money);

        expect(a.hasType('own_money')).toBe(true);
        expect(b.hasType('own_money')).toBe(true);
    });
});

/**
 * The invariant behind the fix above, asserted directly.
 *
 * Copying the built-ins removes the one mechanism that was emptying a root,
 * but `registerType` is what the docs now point people to when they want to be
 * sure a type is registered — so its success must mean the ROOT holds the
 * type, not merely that a bookkeeping map does. Here the type is removed from
 * the root by force, standing in for any future path that reparents one.
 */
describe('registerType repairs a root missing a type it has on record', () => {
    it('re-adds the type instead of returning success from the map alone', () => {
        const factory = new MessageFactory();
        factory.init([]);
        expect(factory.hasType('bigint')).toBe(true);

        // Force the divergence the map cannot see.
        const root: any = (factory as any).root;
        root.remove(root.lookupType('bigint'));
        expect(factory.hasType('bigint')).toBe(false);

        factory.registerType(BigIntType);

        expect(factory.hasType('bigint')).toBe(true);
    });

    it('and the factory can encode again afterwards', () => {
        const factory = new MessageFactory();
        factory.init([]);
        const root: any = (factory as any).root;
        root.remove(root.lookupType('bigint'));

        factory.registerType(BigIntType);
        factory.parse(schemaUsing('Repair'), 'Repair.Wallet');

        expect(() => factory.buildRequest('Repair.Wallet.credit', { value: 5n }, 'x')).not.toThrow();
    });
});
