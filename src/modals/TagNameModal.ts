import { App, Modal, Setting } from 'obsidian';

export class TagNameModal extends Modal {
  private tagName: string = '';
  private onSubmit: (name: string) => void;

  constructor(app: App, onSubmit: (name: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty(); // Clear previous content
    contentEl.createEl('h2', { text: 'Enter New Tag Name' });

    new Setting(contentEl)
      .setName('Tag name')
      .setDesc('Enter the name for the new tag. Do not include #.')
      .addText((text) => {
        text
          .setPlaceholder('e.g., my-new-tag')
          .setValue(this.tagName)
          .onChange((value) => {
            this.tagName = value;
          });
        text.inputEl.addEventListener('keypress', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault(); // Prevent default form submission if any
            this.submitForm();
          }
        });
      });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText('Add Tag')
          .setCta()
          .onClick(() => {
            this.submitForm();
          })
      )
      .addButton((btn) =>
        btn.setButtonText('Cancel').onClick(() => {
          this.close();
        })
      );
  }

  private submitForm() {
    if (this.tagName.trim()) {
      this.onSubmit(this.tagName.trim());
      this.close();
    } else {
      // Optionally, show a small notice or shake the modal if the input is empty
      // For now, just don't submit.
      console.warn('[TagNameModal] Attempted to submit empty tag name.');
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
