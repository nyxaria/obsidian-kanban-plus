import { App, TFile } from 'obsidian';

import { debugLog } from './helpers/debugLogger';
import KanbanPlugin from './main';

export interface SessionData {
  memberBoard?: {
    selectedMember?: string;
    scanRootPath?: string;
    sortBy?: 'dueDate' | 'priority';
    sortOrder?: 'asc' | 'desc';
    [key: string]: any; // Allow for future expansion
  };
  [key: string]: any; // Allow for other session data
}

export class SessionManager {
  private app: App;
  private plugin: KanbanPlugin;
  private sessionData: SessionData = {};
  private sessionFilePath: string;

  constructor(plugin: KanbanPlugin) {
    this.app = plugin.app;
    this.plugin = plugin;
    // Store session.json in the plugin directory
    this.sessionFilePath = `${this.plugin.manifest.dir}/session.json`;
  }

  async loadSession(): Promise<SessionData> {
    try {
      const adapter = this.app.vault.adapter;

      // Check if session file exists
      if (await adapter.exists(this.sessionFilePath)) {
        const sessionContent = await adapter.read(this.sessionFilePath);
        this.sessionData = JSON.parse(sessionContent);
        debugLog('[SessionManager] Session data loaded:', this.sessionData);
      } else {
        // Create default session data
        this.sessionData = {
          memberBoard: {
            selectedMember: '',
            scanRootPath: '',
          },
        };
        debugLog('[SessionManager] Created default session data:', this.sessionData);
      }
    } catch (error) {
      console.error('[SessionManager] Error loading session data:', error);
      // Create default session data on error
      this.sessionData = {
        memberBoard: {
          selectedMember: '',
          scanRootPath: '',
        },
      };
    }

    return this.sessionData;
  }

  async saveSession(): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      const sessionContent = JSON.stringify(this.sessionData, null, 2);

      await adapter.write(this.sessionFilePath, sessionContent);
      debugLog('[SessionManager] Session data saved:', this.sessionData);
    } catch (error) {
      console.error('[SessionManager] Error saving session data:', error);
    }
  }

  // Member Board specific methods
  getMemberBoardSession(): { selectedMember: string; scanRootPath: string; sortBy?: 'dueDate' | 'priority'; sortOrder?: 'asc' | 'desc' } {
    return {
      selectedMember: this.sessionData.memberBoard?.selectedMember || '',
      scanRootPath: this.sessionData.memberBoard?.scanRootPath || '',
      sortBy: this.sessionData.memberBoard?.sortBy,
      sortOrder: this.sessionData.memberBoard?.sortOrder,
    };
  }

  async setMemberBoardSession(data: {
    selectedMember?: string;
    scanRootPath?: string;
    sortBy?: 'dueDate' | 'priority';
    sortOrder?: 'asc' | 'desc';
  }): Promise<void> {
    if (!this.sessionData.memberBoard) {
      this.sessionData.memberBoard = {};
    }

    if (data.selectedMember !== undefined) {
      this.sessionData.memberBoard.selectedMember = data.selectedMember;
    }

    if (data.scanRootPath !== undefined) {
      this.sessionData.memberBoard.scanRootPath = data.scanRootPath;
    }

    if (data.sortBy !== undefined) {
      this.sessionData.memberBoard.sortBy = data.sortBy;
    }

    if (data.sortOrder !== undefined) {
      this.sessionData.memberBoard.sortOrder = data.sortOrder;
    }

    await this.saveSession();
  }

  // Generic methods for future expansion
  getSessionValue(key: string): any {
    return this.sessionData[key];
  }

  async setSessionValue(key: string, value: any): Promise<void> {
    this.sessionData[key] = value;
    await this.saveSession();
  }

  // Clear session data (useful for debugging or reset)
  async clearSession(): Promise<void> {
    this.sessionData = {
      memberBoard: {
        selectedMember: '',
        scanRootPath: '',
      },
    };
    await this.saveSession();
  }
}
