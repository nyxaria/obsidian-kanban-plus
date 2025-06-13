import moment from 'moment';
import { App, Modal, Setting } from 'obsidian';

export interface TaskForEmail {
  title: string;
  boardName: string;
  boardPath: string;
  dueDate: string;
  tags?: string[];
  priority?: 'high' | 'medium' | 'low';
  laneName: string;
}

// Default priority colors removed as HTML is not used
// const DEFAULT_PRIORITY_COLORS: Record<string, string> = {
//   high: '#FF0000',
//   medium: '#FFA500',
//   low: '#0000FF',
// };

export class ReminderModal extends Modal {
  tasksByEmail: Record<string, Array<TaskForEmail>>;
  reminderTimeframeDays: number;

  constructor(
    app: App,
    tasksByEmail: Record<string, Array<TaskForEmail>>,
    reminderTimeframeDays: number
  ) {
    super(app);
    this.tasksByEmail = tasksByEmail;
    this.reminderTimeframeDays = reminderTimeframeDays;
  }

  convertWikilinksToObsidianUrls(text: string): string {
    if (!text) return text;

    // Get the vault name for the obsidian:// URL
    const vaultName = this.app.vault.getName();

    let result = text;

    // Replace external markdown links [text](url) first
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, linkText, url) => {
      return `${linkText} (${url})`;
    });

    // Replace wikilinks with Obsidian URLs
    // Pattern matches: [[filename]] or [[path/filename]] or [[filename|display text]]
    result = result.replace(
      /\[\[([^\]|]+)(\|([^\]]+))?\]\]/g,
      (match, filePath, pipe, displayText) => {
        // Use display text if provided, otherwise use the filename
        const linkText = displayText || filePath.split('/').pop() || filePath;

        // Encode the file path for URL
        const encodedPath = encodeURIComponent(filePath);

        // Create the obsidian:// URL
        const obsidianUrl = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodedPath}`;

        // Return as a clickable link (for plain text emails, this will show as a URL)
        return `${linkText} (${obsidianUrl})`;
      }
    );

    return result;
  }

  createBoardLink(boardName: string, boardPath: string): string {
    // Get the vault name for the obsidian:// URL
    const vaultName = this.app.vault.getName();

    // Encode the file path for URL
    const encodedPath = encodeURIComponent(boardPath);

    // Create the obsidian:// URL
    const obsidianUrl = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodedPath}`;

    // Text version for mailto links
    return `${boardName} (${obsidianUrl})`;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Due Soon Kanban Tasks' });

    if (Object.keys(this.tasksByEmail).length === 0) {
      contentEl.createEl('p', { text: 'No tasks due soon for members with configured emails.' });
      return;
    }

    const timeframeText =
      this.reminderTimeframeDays === 1 ? 'day' : `${this.reminderTimeframeDays} days`;

    for (const email in this.tasksByEmail) {
      let tasks = this.tasksByEmail[email];
      if (tasks.length > 0) {
        // 1. Sort tasks by due date (sooner first)
        tasks.sort((a, b) => moment(a.dueDate).diff(moment(b.dueDate)));

        // Reverted to plain text email body
        let emailBody = `You have the following tasks due in the next ${timeframeText}:\n\n`;

        tasks.forEach((task) => {
          const dueDateMoment = moment(task.dueDate);
          const today = moment().startOf('day');
          const daysUntilDue = dueDateMoment.diff(today, 'days');
          let dueInText = '';
          if (daysUntilDue < 0) {
            dueInText = `overdue by ${Math.abs(daysUntilDue)} day(s)`;
          } else if (daysUntilDue === 0) {
            dueInText = 'today';
          } else if (daysUntilDue === 1) {
            dueInText = '1 day';
          } else {
            dueInText = `${daysUntilDue} days`;
          }

          let cleanTitle = task.title
            .replace(/@\{[^}]+\}/g, '') // Remove @{date}
            .replace(/!\[[^]]+\]/g, '') // Remove ![priority] (if it was part of the title)
            .replace(/!\w+/g, '') // Remove !high, !medium, !low (if it was part of the title)
            .replace(/@@\w+/g, '') // Remove @@member
            .replace(/#\w+(\/\w+)*\s?/g, '') // Remove #tags and #nested/tags
            .replace(/\s{2,}/g, ' ') // Replace multiple spaces with single
            .trim();

          // Convert wikilinks to Obsidian URLs
          cleanTitle = this.convertWikilinksToObsidianUrls(cleanTitle);

          // Create board link
          const boardLink = this.createBoardLink(task.boardName, task.boardPath);

          // Capitalize priority (first letter only), no color
          let priorityDisplay = '';
          if (task.priority) {
            priorityDisplay = `[${task.priority.charAt(0).toUpperCase() + task.priority.slice(1)}] `;
          }

          emailBody += `- ${cleanTitle} @ ${boardLink}:${task.laneName} ${priorityDisplay}[${dueInText}]\n\n`; // Added extra newline for separation
        });
        emailBody += 'Regards,\nYour Kanban Plugin';

        const encodedSubject = encodeURIComponent('Kanban Task Reminders - Due Soon');
        const encodedBody = encodeURIComponent(emailBody);
        const mailtoLink = `mailto:${email}?subject=${encodedSubject}&body=${encodedBody}`;

        new Setting(contentEl)
          .setName(`Email to ${email} (${tasks.length} task(s) due in ${timeframeText})`)
          .setDesc('Click the button to compose this reminder in your email client.') // Reverted description
          .addButton((button) => {
            button
              .setButtonText('Compose Email')
              .setCta()
              .onClick(() => {
                window.open(mailtoLink, '_blank');
              });
          });
      }
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
