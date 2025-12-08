import MessageFactory, { bigintToBytes, bytesToBigint, ICustomType } from '../../lib/message_factory';

describe('BigInt conversion utilities', () => {
    describe('bigintToBytes', () => {
        it('should convert zero', () => {
            const bytes = bigintToBytes(0n);
            expect(bytes.length).toBe(32);
            expect(bytes.every(b => b === 0)).toBe(true);
        });

        it('should convert small numbers', () => {
            const bytes = bigintToBytes(255n);
            expect(bytes[31]).toBe(255);
            expect(bytes.slice(0, 31).every(b => b === 0)).toBe(true);
        });

        it('should convert in big-endian order', () => {
            const bytes = bigintToBytes(0x1234n);
            expect(bytes[30]).toBe(0x12);
            expect(bytes[31]).toBe(0x34);
        });

        it('should handle uint64 max value', () => {
            const uint64Max = 2n ** 64n - 1n;
            const bytes = bigintToBytes(uint64Max);
            // Last 8 bytes should all be 0xff
            expect(bytes.slice(24, 32).every(b => b === 0xff)).toBe(true);
            expect(bytes.slice(0, 24).every(b => b === 0)).toBe(true);
        });

        it('should handle uint256 max value', () => {
            const uint256Max = 2n ** 256n - 1n;
            const bytes = bigintToBytes(uint256Max);
            expect(bytes.every(b => b === 0xff)).toBe(true);
        });

        it('should accept string input (decimal)', () => {
            const bytes = bigintToBytes('12345678901234567890');
            const recovered = bytesToBigint(bytes);
            expect(recovered).toBe(12345678901234567890n);
        });

        it('should accept string input (hex)', () => {
            const bytes = bigintToBytes('0xdeadbeef');
            const recovered = bytesToBigint(bytes);
            expect(recovered).toBe(0xdeadbeefn);
        });

        it('should accept number input', () => {
            const bytes = bigintToBytes(42);
            const recovered = bytesToBigint(bytes);
            expect(recovered).toBe(42n);
        });
    });

    describe('bytesToBigint', () => {
        it('should handle empty/null input', () => {
            expect(bytesToBigint(new Uint8Array(0))).toBe(0n);
            expect(bytesToBigint(null as any)).toBe(0n);
            expect(bytesToBigint(undefined as any)).toBe(0n);
        });

        it('should convert single byte', () => {
            const bytes = new Uint8Array([42]);
            expect(bytesToBigint(bytes)).toBe(42n);
        });

        it('should convert multi-byte in big-endian order', () => {
            const bytes = new Uint8Array([0x12, 0x34]);
            expect(bytesToBigint(bytes)).toBe(0x1234n);
        });

        it('should handle Buffer input', () => {
            const buf = Buffer.from([0xab, 0xcd]);
            expect(bytesToBigint(buf)).toBe(0xabcdn);
        });
    });

    describe('round-trip conversion', () => {
        const testCases = [
            0n,
            1n,
            255n,
            256n,
            65535n,
            0x123456789abcdef0n,
            2n ** 64n - 1n,  // max uint64
            2n ** 128n - 1n, // max uint128
            2n ** 256n - 1n, // max uint256
        ];

        testCases.forEach(value => {
            it(`should round-trip ${value <= 1000n ? value.toString() : '2^' + Math.log2(Number(value + 1n))}`, () => {
                const bytes = bigintToBytes(value);
                const recovered = bytesToBigint(bytes);
                expect(recovered).toBe(value);
            });
        });
    });
});

describe('BigInt proto wrapper integration', () => {
    let messageFactory: MessageFactory;

    beforeAll(() => {
        messageFactory = new MessageFactory();
        messageFactory.init([]);

        // Parse a test proto that uses the bigint type
        messageFactory.parse(`
            syntax = "proto3";
            package TestBigInt;

            message TokenAmount {
                bigint amount = 1;
                string token = 2;
            }

            message Transaction {
                bigint value = 1;
                bigint gas_price = 2;
                bigint gas_limit = 3;
            }

            service TokenService {
                rpc transfer(TokenAmount) returns(TokenAmount);
            }
        `);
    });

    it('should encode and decode bigint field', () => {
        const original = { amount: 12345678901234567890n, token: 'ETH' };
        const encoded = messageFactory.buildRequest('TestBigInt.TokenService.transfer', original, 'test-actor');
        const decoded = messageFactory.decodeRequest(encoded);

        expect(decoded.data.amount).toBe(12345678901234567890n);
        expect(typeof decoded.data.amount).toBe('bigint');
        expect(decoded.data.token).toBe('ETH');
    });

    it('should handle string input for bigint field (decimal)', () => {
        const original = { amount: '999999999999999999999', token: 'USDC' };
        const encoded = messageFactory.buildRequest('TestBigInt.TokenService.transfer', original, 'test-actor');
        const decoded = messageFactory.decodeRequest(encoded);

        expect(decoded.data.amount).toBe(999999999999999999999n);
        expect(typeof decoded.data.amount).toBe('bigint');
    });

    it('should handle hex string input for bigint field', () => {
        const original = { amount: '0xffffffffffffffff', token: 'WBTC' };
        const encoded = messageFactory.buildRequest('TestBigInt.TokenService.transfer', original, 'test-actor');
        const decoded = messageFactory.decodeRequest(encoded);

        expect(decoded.data.amount).toBe(0xffffffffffffffffn);
    });

    it('should handle uint256 max value', () => {
        const uint256Max = 2n ** 256n - 1n;
        const original = { amount: uint256Max, token: 'DAI' };
        const encoded = messageFactory.buildRequest('TestBigInt.TokenService.transfer', original, 'test-actor');
        const decoded = messageFactory.decodeRequest(encoded);

        expect(decoded.data.amount).toBe(uint256Max);
    });

    it('should handle zero bigint', () => {
        const original = { amount: 0n, token: 'LINK' };
        const encoded = messageFactory.buildRequest('TestBigInt.TokenService.transfer', original, 'test-actor');
        const decoded = messageFactory.decodeRequest(encoded);

        expect(decoded.data.amount).toBe(0n);
    });

    it('should export bigint type as TypeScript bigint', () => {
        const ts = messageFactory.exportTS('TestBigInt.TokenService');
        expect(ts).toContain('amount?: (bigint | null)');
    });
});

describe('Timestamp proto wrapper integration', () => {
    let messageFactory: MessageFactory;

    beforeAll(() => {
        messageFactory = new MessageFactory();
        messageFactory.init([]);

        messageFactory.parse(`
            syntax = "proto3";
            package TestTimestamp;

            message Event {
                string name = 1;
                timestamp created_at = 2;
                timestamp updated_at = 3;
            }

            service EventService {
                rpc create(Event) returns(Event);
            }
        `);
    });

    it('should encode and decode Date objects', () => {
        const now = new Date();
        const original = { name: 'test', created_at: now, updated_at: now };
        const encoded = messageFactory.buildRequest('TestTimestamp.EventService.create', original, 'test-actor');
        const decoded = messageFactory.decodeRequest(encoded);

        expect(decoded.data.created_at).toBeInstanceOf(Date);
        expect(decoded.data.created_at.getTime()).toBe(now.getTime());
    });

    it('should accept ISO string input', () => {
        const isoString = '2024-01-15T10:30:00.000Z';
        const original = { name: 'test', created_at: isoString };
        const encoded = messageFactory.buildRequest('TestTimestamp.EventService.create', original, 'test-actor');
        const decoded = messageFactory.decodeRequest(encoded);

        expect(decoded.data.created_at).toBeInstanceOf(Date);
        expect(decoded.data.created_at.toISOString()).toBe(isoString);
    });

    it('should accept milliseconds number input', () => {
        const ms = Date.now();
        const original = { name: 'test', created_at: ms };
        const encoded = messageFactory.buildRequest('TestTimestamp.EventService.create', original, 'test-actor');
        const decoded = messageFactory.decodeRequest(encoded);

        expect(decoded.data.created_at).toBeInstanceOf(Date);
        expect(decoded.data.created_at.getTime()).toBe(ms);
    });

    it('should export timestamp type as TypeScript Date', () => {
        const ts = messageFactory.exportTS('TestTimestamp.EventService');
        expect(ts).toContain('created_at?: (Date | null)');
    });
});

describe('Custom type registration', () => {
    it('should allow registering custom types', () => {
        const messageFactory = new MessageFactory();

        // Define a custom UUID type
        const uuidType: ICustomType<string> = {
            name: 'uuid',
            wireType: 'bytes',
            tsType: 'string',
            encode: (value: string) => Buffer.from(value.replace(/-/g, ''), 'hex'),
            decode: (data: Buffer) => {
                const hex = Buffer.from(data).toString('hex');
                return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
            }
        };

        messageFactory.registerType(uuidType);
        messageFactory.init([]);

        messageFactory.parse(`
            syntax = "proto3";
            package TestUUID;

            message Entity {
                uuid id = 1;
                string name = 2;
            }

            service EntityService {
                rpc get(Entity) returns(Entity);
            }
        `);

        const testUuid = '550e8400-e29b-41d4-a716-446655440000';
        const original = { id: testUuid, name: 'Test Entity' };
        const encoded = messageFactory.buildRequest('TestUUID.EntityService.get', original, 'test-actor');
        const decoded = messageFactory.decodeRequest(encoded);

        expect(decoded.data.id).toBe(testUuid);
        expect(decoded.data.name).toBe('Test Entity');
    });

    it('should support registering types after init', () => {
        const messageFactory = new MessageFactory();
        messageFactory.init([]);

        // Define a simple custom type
        const boolAsIntType: ICustomType<boolean> = {
            name: 'boolint',
            wireType: 'int32',
            tsType: 'boolean',
            encode: (value: boolean) => value ? 1 : 0,
            decode: (data: number) => data !== 0
        };

        messageFactory.registerType(boolAsIntType);

        messageFactory.parse(`
            syntax = "proto3";
            package TestBoolInt;

            message Flags {
                boolint active = 1;
                boolint verified = 2;
            }

            service FlagService {
                rpc update(Flags) returns(Flags);
            }
        `);

        const original = { active: true, verified: false };
        const encoded = messageFactory.buildRequest('TestBoolInt.FlagService.update', original, 'test-actor');
        const decoded = messageFactory.decodeRequest(encoded);

        expect(decoded.data.active).toBe(true);
        expect(decoded.data.verified).toBe(false);
    });

    it('should export custom type with correct TypeScript type', () => {
        const messageFactory = new MessageFactory();

        const customType: ICustomType<number[]> = {
            name: 'intarray',
            wireType: 'bytes',
            tsType: 'number[]',
            encode: (value: number[]) => Buffer.from(value),
            decode: (data: Buffer) => Array.from(data)
        };

        messageFactory.registerType(customType);
        messageFactory.init([]);

        messageFactory.parse(`
            syntax = "proto3";
            package TestArray;

            message Data {
                intarray values = 1;
            }

            service DataService {
                rpc process(Data) returns(Data);
            }
        `);

        const ts = messageFactory.exportTS('TestArray.DataService');
        expect(ts).toContain('values?: (number[] | null)');
    });
});
