teamMemberColors?: Record<string, TeamMemberColorConfig>;
editable?: boolean;
memberAssignmentPrefix?: string;
}

// ... existing code ...
'teamMemberColors',
'editable',
'memberAssignmentPrefix',
]);

// ... existing code ...
teamMemberColors: {},
editable: true,
memberAssignmentPrefix: '@@',
};

// ... existing code ...

    new Setting(containerEl)
      .setName(t('Member Assignment Prefix'))
      .setDesc(t('The prefix used to identify member assignments in card text (e.g., @@User)'))
      .addText((text) =>
        text
          .setPlaceholder('@@')
          .setValue(this.plugin.settings.memberAssignmentPrefix)
          .onChange(async (value) => {
            this.plugin.settings.memberAssignmentPrefix = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('Saved Workspace Views'))
      .setDesc(t('Manage your saved workspace view configurations.'))
// ... existing code ... 