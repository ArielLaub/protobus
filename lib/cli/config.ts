import * as fs from 'fs';
import * as path from 'path';

export interface ProtobusConfig {
    /** Directory containing .proto files (default: ./proto) */
    protoDir: string;
    /** Output path for generated TypeScript types (default: ./common/types/proto.ts) */
    typesOutput: string;
    /** Directory for generated service stubs (default: ./services) */
    servicesDir: string;
}

const DEFAULT_CONFIG: ProtobusConfig = {
    protoDir: './proto',
    typesOutput: './common/types/proto.ts',
    servicesDir: './services',
};

/**
 * Load protobus configuration from package.json or use defaults.
 *
 * Users can add a "protobus" section to their package.json:
 * ```json
 * {
 *   "protobus": {
 *     "protoDir": "./proto",
 *     "typesOutput": "./common/types/proto.ts",
 *     "servicesDir": "./services"
 *   }
 * }
 * ```
 */
export function loadConfig(cwd: string = process.cwd()): ProtobusConfig {
    const packageJsonPath = path.join(cwd, 'package.json');

    if (fs.existsSync(packageJsonPath)) {
        try {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            if (packageJson.protobus) {
                return {
                    ...DEFAULT_CONFIG,
                    ...packageJson.protobus,
                };
            }
        } catch {
            // Ignore parse errors, use defaults
        }
    }

    return DEFAULT_CONFIG;
}

/**
 * Resolve a path relative to cwd
 */
export function resolvePath(configPath: string, cwd: string = process.cwd()): string {
    if (path.isAbsolute(configPath)) {
        return configPath;
    }
    return path.join(cwd, configPath);
}

/**
 * Get default configuration values
 */
export function getDefaults(): ProtobusConfig {
    return { ...DEFAULT_CONFIG };
}
