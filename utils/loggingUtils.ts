/**
 * Logging utilities with color formatting for TypeScript
 */

export enum LogLevel {
    INFO = 'info',
    WARNING = 'warning', 
    ERROR = 'error',
    IMPORTANT = 'important',
    CRITICAL = 'critical'
}

// ANSI color codes with TypeScript-native patterns
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m'
} as const;

interface LogEntry {
    readonly level: LogLevel;
    readonly message: string;
    readonly timestamp: string;
}

interface ColorConfig {
    readonly colorCode: string;
    readonly levelText: string;
}

type ConsoleMethod = typeof console.log | typeof console.warn | typeof console.error;

interface LoggingConfig {
    readonly enableColors: boolean;
    readonly minLevel: LogLevel;
    readonly includeStackTrace: boolean;
}

const defaultLoggingConfig: LoggingConfig = {
    enableColors: true,
    minLevel: LogLevel.INFO,
    includeStackTrace: false
} as const;

class Logger {
    private _config: LoggingConfig = defaultLoggingConfig;

    private readonly colorConfigs: ReadonlyMap<LogLevel, ColorConfig> = new Map([
        [LogLevel.INFO, { colorCode: colors.blue, levelText: 'INFO' }],
        [LogLevel.WARNING, { colorCode: colors.yellow, levelText: 'WARN' }],
        [LogLevel.ERROR, { colorCode: colors.red, levelText: 'ERROR' }],
        [LogLevel.IMPORTANT, { colorCode: colors.green + colors.bright, levelText: 'IMPORTANT' }],
        [LogLevel.CRITICAL, { colorCode: colors.red + colors.bright, levelText: 'CRITICAL' }]
    ] as const);

    private readonly consoleMethods: ReadonlyMap<LogLevel, ConsoleMethod> = new Map([
        [LogLevel.INFO, console.log],
        [LogLevel.WARNING, console.warn],
        [LogLevel.ERROR, console.error],
        [LogLevel.IMPORTANT, console.log],
        [LogLevel.CRITICAL, console.error]
    ] as const);

    private formatMessage(level: LogLevel, message: string): string {
        const timestamp: string = new Date().toISOString();
        const config: ColorConfig | undefined = this.colorConfigs.get(level);
        
        if (!config) {
            throw new Error(`Unknown log level: ${level}`);
        }

        const { colorCode, levelText }: ColorConfig = config;
        return `${colorCode}[${timestamp}] ${levelText}: ${message}${colors.reset}`;
    }

    private logWithLevel(level: LogLevel, message: string): void {
        const formattedMessage: string = this.formatMessage(level, message);
        const consoleMethod: ConsoleMethod | undefined = this.consoleMethods.get(level);
        
        if (!consoleMethod) {
            throw new Error(`No console method configured for log level: ${level}`);
        }
        
        consoleMethod(formattedMessage);
    }

    info(message: string): void {
        this.logWithLevel(LogLevel.INFO, message);
    }

    warning(message: string): void {
        this.logWithLevel(LogLevel.WARNING, message);
    }

    error(message: string): void {
        this.logWithLevel(LogLevel.ERROR, message);
    }

    important(message: string): void {
        this.logWithLevel(LogLevel.IMPORTANT, message);
    }

    critical(message: string): void {
        this.logWithLevel(LogLevel.CRITICAL, message);
    }

    // TypeScript-native log method with type safety
    log(level: LogLevel, message: string): void {
        this.logWithLevel(level, message);
    }

    // Create a typed log entry (useful for structured logging)
    createLogEntry(level: LogLevel, message: string): LogEntry {
        return {
            level,
            message,
            timestamp: new Date().toISOString()
        } as const;
    }

    // Update logger configuration
    updateConfig(config: Partial<LoggingConfig>): void {
        this._config = { ...this._config, ...config };
    }

    // Get current configuration
    get config(): Readonly<LoggingConfig> {
        return this._config;
    }
}

// Create and export a singleton logger instance
export const logger = new Logger();

export function setupLogging(config: Partial<LoggingConfig> = {}): void {
    const finalConfig: LoggingConfig = { ...defaultLoggingConfig, ...config };
    
    // Update logger with new configuration
    logger.updateConfig(finalConfig);
    
    // Setup any additional logging configuration if needed
    if (!finalConfig.enableColors) {
        logger.info('Color logging disabled');
    }
}
