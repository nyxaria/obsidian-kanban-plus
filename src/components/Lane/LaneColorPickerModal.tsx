import { App, Modal } from 'obsidian';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';

import StateManager from '../../StateManager';
import { t } from '../../lang/helpers';

interface LaneColorPickerModalProps {
  app: App;
  laneId: string;
  stateManager: StateManager;
  initialColor?: string;
  onClose: () => void;
}

const LaneColorPickerModalComponent: React.FC<LaneColorPickerModalProps> = ({
  app,
  laneId,
  stateManager,
  initialColor,
  onClose,
}) => {
  const [selectedColor, setSelectedColor] = useState<string>(initialColor || '#000000');

  const handleApply = async () => {
    await stateManager.setLaneBackgroundColor(laneId, selectedColor);
    onClose();
  };

  return (
    <div className="modal-content">
      <div className="setting-item">
        <div className="setting-item-info">
          <div className="setting-item-name">{t('text_choose_color_label')}</div>
        </div>
        <div className="setting-item-control">
          <input
            type="color"
            id="lane-color-picker"
            value={selectedColor}
            onChange={(e) => setSelectedColor(e.target.value)}
            style={{ width: '100px' }}
          />
        </div>
      </div>

      <div className="setting-item modal-button-container">
        <button onClick={handleApply} className="mod-cta">
          Submit
        </button>
        <button onClick={onClose}>{t('Cancel')}</button>
      </div>
    </div>
  );
};

export class LaneColorPickerModal extends Modal {
  private root: ReturnType<typeof createRoot> | null = null;
  private readonly laneId: string;
  private readonly stateManager: StateManager;
  private readonly initialColor?: string;

  constructor(app: App, laneId: string, stateManager: StateManager, initialColor?: string) {
    super(app);
    this.laneId = laneId;
    this.stateManager = stateManager;
    this.initialColor = initialColor;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(t('text_set_lane_background_color'));

    this.root = createRoot(contentEl);
    this.root.render(
      <React.StrictMode>
        <LaneColorPickerModalComponent
          app={this.app}
          laneId={this.laneId}
          stateManager={this.stateManager}
          initialColor={this.initialColor}
          onClose={() => this.close()}
        />
      </React.StrictMode>
    );
  }

  onClose() {
    this.root?.unmount();
    const { contentEl } = this;
    contentEl.empty();
  }
}
