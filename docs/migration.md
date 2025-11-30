# Migration Guide

Guide for upgrading between Protobus versions.

## Version Compatibility

| Protobus | Node.js | RabbitMQ | TypeScript |
|----------|---------|----------|------------|
| 0.9.x | 14+ | 3.8+ | 4.0+ |
| 0.8.x | 12+ | 3.6+ | 3.7+ |

## Upgrading to 0.9.x

### Breaking Changes

None - 0.9.x is backwards compatible with 0.8.x.

### New Features

- Improved event routing with Trie-based matching
- Better error messages
- Updated dependencies

### Recommended Updates

1. **Update Node.js types**
   ```bash
   npm install @types/node@latest --save-dev
   ```

2. **Update TypeScript**
   ```bash
   npm install typescript@latest --save-dev
   ```

## Upgrading from 0.7.x to 0.8.x

### Breaking Changes

1. **ServiceProxy initialization**
   ```typescript
   // Before (0.7.x)
   const proxy = new ServiceProxy(context, 'Service');
   const result = await proxy.method({});

   // After (0.8.x)
   const proxy = new ServiceProxy(context, 'Service');
   await proxy.init();  // Required!
   const result = await proxy.method({});
   ```

2. **Event subscription**
   ```typescript
   // Before (0.7.x)
   service.on('EventType', handler);

   // After (0.8.x)
   await service.subscribeEvent('Package.EventType', handler);
   ```

### Migration Steps

1. Add `await proxy.init()` after creating ServiceProxy instances
2. Update event subscriptions to use `subscribeEvent()`
3. Add package prefix to event types

## Dependency Updates

### Updating amqplib

If updating `amqplib` to a newer version:

```bash
npm install amqplib@latest @types/amqplib@latest
```

**Potential issues:**
- Channel API changes
- Connection options changes

**Test thoroughly** after updating.

### Migrating from tslint to eslint

TSLint is deprecated. Migrate to ESLint:

1. **Remove tslint**
   ```bash
   npm uninstall tslint
   rm tslint.json
   ```

2. **Install ESLint**
   ```bash
   npm install eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin --save-dev
   ```

3. **Create .eslintrc.js**
   ```javascript
   module.exports = {
       parser: '@typescript-eslint/parser',
       plugins: ['@typescript-eslint'],
       extends: [
           'eslint:recommended',
           'plugin:@typescript-eslint/recommended'
       ],
       parserOptions: {
           ecmaVersion: 2020,
           sourceType: 'module'
       },
       rules: {
           // Add your rules
       }
   };
   ```

4. **Update package.json scripts**
   ```json
   {
       "scripts": {
           "lint": "eslint 'src/**/*.ts'"
       }
   }
   ```

### Updating Node.js Types

The project uses very old Node.js types. Update:

```bash
npm install @types/node@20 --save-dev
```

**Potential issues:**
- Some type definitions may have changed
- Buffer handling may need updates

## Proto File Changes

### Adding New Fields

Adding new fields is backwards compatible:

```protobuf
// Before
message Order {
    string order_id = 1;
}

// After - Safe
message Order {
    string order_id = 1;
    string notes = 2;  // New field
}
```

### Removing Fields

Mark removed fields as reserved:

```protobuf
// Before
message Order {
    string order_id = 1;
    string old_field = 2;
}

// After - Safe
message Order {
    reserved 2;
    reserved "old_field";
    string order_id = 1;
}
```

### Renaming Services

Service renames require coordination:

1. Deploy new service with new name
2. Update all clients
3. Remove old service

```typescript
// Step 1: Support both names temporarily
class OrderService extends MessageService {
    get ServiceName() { return 'Orders.OrderService'; }  // New name
}

class LegacyOrderService extends MessageService {
    get ServiceName() { return 'Order.Service'; }  // Old name

    // Delegate to new service
    async createOrder(req) {
        return this.newService.createOrder(req);
    }
}
```

## Testing After Migration

1. **Run unit tests**
   ```bash
   npm test
   ```

2. **Test RPC calls**
   ```typescript
   // Test each service method
   const result = await proxy.method({ testData: 'value' });
   assert(result.expectedField);
   ```

3. **Test events**
   ```typescript
   // Verify event publishing and subscription
   let received = false;
   await subscriber.subscribeEvent('Test.Event', async () => {
       received = true;
   });
   await publisher.publishEvent('Test.Event', {});
   await sleep(100);
   assert(received);
   ```

4. **Test error handling**
   ```typescript
   // Verify errors are properly returned
   try {
       await proxy.methodThatThrows({});
       assert.fail('Should have thrown');
   } catch (error) {
       assert(error.message.includes('expected'));
   }
   ```

## Rollback Plan

If migration fails:

1. **Keep old code available**
   ```bash
   git checkout -b migration-backup
   ```

2. **Version your deployments**
   ```bash
   docker tag myservice:latest myservice:pre-migration
   ```

3. **Test in staging first**
   - Deploy to staging environment
   - Run full test suite
   - Monitor for errors

4. **Gradual rollout**
   - Deploy to one instance
   - Monitor metrics
   - Expand deployment

---

Next: [Known Issues](./known-issues.md) | [Troubleshooting](./troubleshooting.md)
