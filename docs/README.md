# Protobus Documentation

A TypeScript microservices framework using RabbitMQ and Protocol Buffers.

## Table of Contents

### Getting Started
- [Quick Start Guide](./getting-started.md) - Installation and first service
- [CLI](./cli.md) - Type generation and service scaffolding
- [Configuration](./configuration.md) - Environment variables and options
- [Examples](./examples.md) - Common patterns and use cases

### Core Concepts
- [Architecture Overview](./architecture.md) - System design and components
- [Message Flow](./message-flow.md) - How messages are routed and processed

### API Reference
- [Context](./api/context.md) - Main orchestrator
- [MessageService](./api/message-service.md) - Base service class
- [RunnableService](./api/runnable-service.md) - Service with lifecycle management
- [ServiceProxy](./api/service-proxy.md) - Client proxy
- [ServiceCluster](./api/service-cluster.md) - Multi-service orchestration
- [Events](./api/events.md) - Pub/sub system

### Advanced Topics
- [Protobuf Schema Design](./advanced/protobuf-schema.md) - Best practices for .proto files
- [Error Handling](./advanced/error-handling.md) - Exception patterns
- [HTTP Routing](./advanced/http-routing.md) - Express integration (experimental)
- [Custom Logger](./advanced/custom-logger.md) - Logging integration

### Operations
- [Troubleshooting](./troubleshooting.md) - Common issues and solutions
- [Known Issues](./known-issues.md) - Current limitations and workarounds
- [Migration Guide](./migration.md) - Upgrading between versions

---

## Quick Links

| Topic | Description |
|-------|-------------|
| [Architecture](./architecture.md) | Understand how Protobus works |
| [Getting Started](./getting-started.md) | Create your first service |
| [API Reference](./api/context.md) | Detailed API documentation |
| [Known Issues](./known-issues.md) | Current limitations |

## Version

This documentation is for Protobus v0.9.x
