import KanbanPlugin from '../main';

let pluginInstance: KanbanPlugin | null = null;

export function setDebugLoggerPlugin(plugin: KanbanPlugin) {
  pluginInstance = plugin;
}

export function debugLog(...args: any[]) {
  if (pluginInstance?.settings?.['print-debug']) {
    console.log(...args);
  }
}

export function debugInfo(...args: any[]) {
  if (pluginInstance?.settings?.['print-debug']) {
    console.info(...args);
  }
}

// These should always log regardless of debug setting
export function errorLog(...args: any[]) {
  console.error(...args);
}

export function warnLog(...args: any[]) {
  console.warn(...args);
}
