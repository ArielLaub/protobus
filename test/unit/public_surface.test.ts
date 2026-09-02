/**
 * Types that appear in public signatures must be exported from the package
 * root.
 *
 * `MessageHandlerContext` is the 4th argument of every service method and
 * `EventHandler` is the 2nd argument of `subscribeEvent`, yet neither could be
 * imported — so every user redeclared them by hand, against a shape the
 * library is free to change. `MissingProto` is the first error a new user
 * hits and could not be caught by type.
 *
 * The oracle here is the compiler: these are types, erased at runtime, so the
 * import below failing to resolve is the failure. ts-jest type-checks the file
 * before running it.
 */
import {
    EventHandler,
    MessageHandlerContext,
    MissingProto,
    IMessageService,
} from '../../index';

describe('public type surface', () => {
    it('exports EventHandler with its real three-argument shape', () => {
        const handler: EventHandler = async (event: any, type: string, topic: string) => {
            expect(typeof type).toBe('string');
            expect(typeof topic).toBe('string');
            expect(event).toBeDefined();
        };
        return handler({ any: 'thing' }, 'Some.Type', 'EVENT.some.topic');
    });

    it('exports EventHandler as the type subscribeEvent actually accepts', () => {
        // Assignability, not shape-by-hand: if subscribeEvent's parameter type
        // ever diverges from the exported one, this stops compiling.
        type Accepted = Parameters<IMessageService['subscribeEvent']>[1];
        const handler: EventHandler = async () => undefined;
        const accepted: Accepted = handler;
        expect(typeof accepted).toBe('function');
    });

    it('exports MessageHandlerContext with the fields a handler is given', () => {
        const controller = new AbortController();
        const context: MessageHandlerContext = {
            signal: controller.signal,
            routingKey: 'REQUEST.Some.Service.method',
            messageId: 'abc',
            redelivered: false,
        };
        expect(context.routingKey).toBe('REQUEST.Some.Service.method');
        expect(context.redelivered).toBe(false);
    });

    it('exports MissingProto so a first-day failure can be caught by type', () => {
        const error: unknown = new MissingProto('missing_proto_source');
        expect(error).toBeInstanceOf(MissingProto);
        expect(error).toBeInstanceOf(Error);
        expect((error as MissingProto).name).toBe('MissingProto');
    });
});
