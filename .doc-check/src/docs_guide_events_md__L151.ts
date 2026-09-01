
// lib/event_listener.ts. Not exported from the package root, so declare it
// yourself if you need a named handler rather than an inline arrow function.
type EventHandler = (event: any, type: string, topic: string) => Promise<void>;
