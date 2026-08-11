import * as path from 'path';

import { assertSafeServiceName, InvalidServiceNameError } from '../../lib/cli/generate-service';

/**
 * The CLI takes a service name straight from argv and interpolates it into
 * filesystem paths. A name containing path separators escapes the configured
 * proto/services directories entirely.
 *
 * Low severity — it is a local developer tool, and the attacker is usually
 * yourself with a typo — but a generator that can write outside its output
 * directory is worth closing, especially anywhere it runs from a script or a
 * project template.
 */
describe('service name validation', () => {
    it.each([
        ['../escape', 'parent traversal'],
        ['../../etc/passwd', 'deep traversal'],
        ['foo/bar', 'forward slash'],
        ['foo\\bar', 'backslash'],
        ['/absolute', 'absolute path'],
        ['.', 'bare dot'],
        ['..', 'bare dot-dot'],
        ['', 'empty'],
        ['with space', 'whitespace'],
        ['nul\0byte', 'null byte'],
    ])('rejects %j (%s)', (name) => {
        expect(() => assertSafeServiceName(name)).toThrow(InvalidServiceNameError);
    });

    it.each([
        'Calculator',
        'OrderService',
        'billing_v2',
        'Report-Generator',
        'Svc123',
    ])('accepts %j', (name) => {
        expect(() => assertSafeServiceName(name)).not.toThrow();
        expect(assertSafeServiceName(name)).toBe(name);
    });

    it('keeps generated paths inside the output directory', () => {
        // The property that actually matters, stated directly.
        const servicesDir = '/tmp/project/src/services';
        const name = assertSafeServiceName('Calculator');
        const resolved = path.resolve(path.join(servicesDir, name.toLowerCase()));
        expect(resolved.startsWith(path.resolve(servicesDir) + path.sep)).toBe(true);
    });
});
