import * as protoBuf from 'protobufjs';
import { Type, Field, Message } from 'protobufjs/light';

/**
 * Interface for defining custom protobuf types with serialization logic.
 * Implement this interface to create your own custom types that can be
 * registered with MessageFactory.
 *
 * @example
 * ```typescript
 * const myCustomType: ICustomType<MyType> = {
 *     name: 'mytype',
 *     wireType: 'bytes',
 *     encode: (value: MyType) => Buffer.from(...),
 *     decode: (data: Buffer) => new MyType(...)
 * };
 *
 * messageFactory.registerType(myCustomType);
 * ```
 */
export interface ICustomType<T = any> {
    /**
     * The name of the type as it will appear in .proto files.
     * Should be lowercase to look like a built-in scalar type.
     * Example: 'bigint', 'timestamp', 'uuid'
     */
    name: string;

    /**
     * The underlying protobuf wire type used for serialization.
     * - 'bytes': Variable length binary data (most flexible)
     * - 'int64': 64-bit integer
     * - 'uint64': Unsigned 64-bit integer
     * - 'string': UTF-8 string
     */
    wireType: 'bytes' | 'int64' | 'uint64' | 'string' | 'int32' | 'uint32' | 'double';

    /**
     * Convert a user-provided value to the wire format.
     * Should handle various input formats gracefully.
     *
     * @param value - The value to encode (type depends on your use case)
     * @returns The encoded value in wire format
     */
    encode: (value: any) => Buffer | Uint8Array | string | number | bigint;

    /**
     * Convert wire format back to the desired output type.
     *
     * @param data - The wire format data
     * @returns The decoded value of type T
     */
    decode: (data: any) => T;

    /**
     * The TypeScript type name to use in generated interfaces.
     * Example: 'bigint', 'Date', 'string'
     */
    tsType: string;
}

// Registry of custom type implementations
const customTypeRegistry = new Map<string, ICustomType>();

/**
 * Internal class to create protobufjs Message classes for custom types
 */
function createMessageClass(customType: ICustomType): typeof Message {
    // Dynamically create a class with the decorator
    @Type.d(customType.name)
    class CustomTypeMessage extends Message<CustomTypeMessage> {
        @Field.d(1, customType.wireType)
        public value: any;
    }

    return CustomTypeMessage as any;
}

/**
 * Register a custom type globally.
 * This registers the protobufjs wrapper and stores the type definition.
 */
export function registerCustomType(customType: ICustomType): typeof Message {
    const MessageClass = createMessageClass(customType);

    // Register wrapper for protobufjs
    (protoBuf.wrappers as any)[`.${customType.name}`] = {
        fromObject(this: protoBuf.Type, object: any): protoBuf.Message {
            let wireValue: any;

            if (object?.value !== undefined) {
                // Already has value property - check if already encoded
                const val = object.value;
                if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
                    wireValue = val;
                } else {
                    wireValue = customType.encode(val);
                }
            } else {
                wireValue = customType.encode(object);
            }

            return this.create({ value: wireValue });
        },

        toObject(this: protoBuf.Type, message: protoBuf.Message): any {
            const wireValue = (message as any).value;
            return customType.decode(wireValue);
        }
    };

    // Store in registry
    customTypeRegistry.set(customType.name, customType);

    return MessageClass;
}

/**
 * Get a registered custom type by name
 */
export function getCustomType(name: string): ICustomType | undefined {
    return customTypeRegistry.get(name);
}

/**
 * Check if a type name is a registered custom type
 */
export function isCustomType(name: string): boolean {
    return customTypeRegistry.has(name);
}

/**
 * Get all registered custom type names
 */
export function getCustomTypeNames(): string[] {
    return Array.from(customTypeRegistry.keys());
}

// ============================================================================
// Built-in Custom Types
// ============================================================================

/** Width of the bigint wire format, in bytes. */
export const BIGINT_BYTES = 32;

/** Largest value representable in the 32-byte unsigned wire format. */
export const BIGINT_MAX = 2n ** 256n - 1n;

/**
 * BigInt type - 32 bytes fixed size, big-endian (uint256 compatible)
 * Supports Web3/crypto applications with large integers.
 *
 * The wire format is **unsigned**. Values outside [0, 2^256-1] are rejected
 * with a RangeError rather than coerced — neither taking the absolute value
 * nor truncating mod 2^256. For financial and on-chain amounts, failing
 * loudly is the only safe behaviour.
 */
export const BigIntType: ICustomType<bigint> = {
    name: 'bigint',
    wireType: 'bytes',
    tsType: 'bigint',

    encode(value: bigint | string | number): Uint8Array {
        let bi: bigint;
        if (typeof value === 'bigint') {
            bi = value;
        } else if (typeof value === 'string') {
            bi = BigInt(value); // Supports hex (0x...) and decimal strings
        } else {
            bi = BigInt(value);
        }

        if (bi < 0n) {
            throw new RangeError(
                `bigint value ${bi} is negative; the protobus bigint wire format is unsigned (0 .. 2^256-1)`,
            );
        }
        if (bi > BIGINT_MAX) {
            throw new RangeError(
                `bigint value ${bi} exceeds the maximum representable value 2^256-1`,
            );
        }

        const bytes = new Uint8Array(BIGINT_BYTES);
        let temp = bi;

        for (let i = BIGINT_BYTES - 1; i >= 0 && temp > 0n; i--) {
            bytes[i] = Number(temp & 0xffn);
            temp >>= 8n;
        }

        return bytes;
    },

    decode(data: Buffer | Uint8Array): bigint {
        if (!data || data.length === 0) {
            return 0n;
        }

        // The accumulator below shifts a growing bigint once per byte, so its
        // cost is quadratic in the input length. The encoder never emits more
        // than BIGINT_BYTES, so anything longer is malformed and there is no
        // reason to spend the time finding out what it decodes to: a 1 MiB
        // value takes over a minute, on the event loop, before a handler runs.
        if (data.length > BIGINT_BYTES) {
            throw new RangeError(
                `bigint wire value is ${data.length} bytes; the protobus bigint ` +
                `wire format is at most ${BIGINT_BYTES}`,
            );
        }

        let result = 0n;
        for (let i = 0; i < data.length; i++) {
            result = (result << 8n) | BigInt(data[i]);
        }
        return result;
    }
};

/**
 * Timestamp type - milliseconds since Unix epoch
 * Serializes to int64, deserializes to Date object.
 */
export const TimestampType: ICustomType<Date> = {
    name: 'timestamp',
    wireType: 'int64',
    tsType: 'Date',

    encode(value: Date | number | string): number {
        if (value instanceof Date) {
            return value.getTime();
        } else if (typeof value === 'string') {
            return new Date(value).getTime();
        } else {
            return value;
        }
    },

    decode(data: number | bigint | { low: number; high: number }): Date {
        // Handle Long type from protobufjs
        if (typeof data === 'object' && data !== null && 'low' in data && 'high' in data) {
            // The high word is SIGNED: every instant before 1970 has its sign
            // bit set, and coercing that away with `>>> 0` turns the whole
            // value into a large positive one — far enough out of range that
            // the Date is Invalid rather than merely wrong. Only the low word
            // is unsigned, being the bottom 32 bits of the magnitude.
            const num = data.high * 0x100000000 + (data.low >>> 0);
            return new Date(num);
        }
        return new Date(Number(data));
    }
};

// Register built-in types immediately
export const BigIntMessage = registerCustomType(BigIntType);
export const TimestampMessage = registerCustomType(TimestampType);

// Export utility functions for backwards compatibility
export function bigintToBytes(value: bigint | string | number): Uint8Array {
    return BigIntType.encode(value) as Uint8Array;
}

export function bytesToBigint(bytes: Uint8Array | Buffer): bigint {
    return BigIntType.decode(bytes);
}
