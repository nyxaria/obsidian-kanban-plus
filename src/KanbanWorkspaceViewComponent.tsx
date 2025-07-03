import React, { useEffect, useState } from 'react';

import { KanbanWorkspaceView } from './KanbanWorkspaceView';
import { SavedWorkspaceView } from './Settings';
import { debugLog } from './helpers/debugLogger';
import KanbanPlugin from './main';

// Assuming KanbanWorkspaceView is exported from a file named KanbanWorkspaceView.ts or .tsx

interface KanbanWorkspaceViewComponentProps {
  plugin: KanbanPlugin;
  view: KanbanWorkspaceView;
  selectedViewId?: string | null; // Or initialLeafSavedViewId based on the main component
  // We also access props.plugin.settings.savedWorkspaceViews
}

const KanbanWorkspaceViewComponent = (props: KanbanWorkspaceViewComponentProps) => {
  const [selectedViewId, setSelectedViewId] = useState(props.selectedViewId);
  const [currentPluginSettings, setCurrentPluginSettings] = useState(props.plugin.settings);
  const [newGlobalLastSelectedId, setNewGlobalLastSelectedId] = useState(
    props.plugin.settings.lastSelectedWorkspaceViewId
  );
  const [isMounted, setIsMounted] = useState(true);

  useEffect(() => {
    // Update global plugin settings only if the lastSelectedWorkspaceViewId has changed
    if (currentPluginSettings.lastSelectedWorkspaceViewId !== newGlobalLastSelectedId) {
      props.plugin.settings.lastSelectedWorkspaceViewId = newGlobalLastSelectedId;
      props.plugin.saveSettings(); // Save the settings
    }
  }, [selectedViewId, JSON.stringify(props.plugin.settings.savedWorkspaceViews)]);

  useEffect(() => {
    // ADDED: useEffect to update isMounted ref
    setIsMounted(true);
    return () => {
      setIsMounted(false);
    };
  }, []);

  return (
    <select
      value={selectedViewId || ''}
      onChange={async (e) => {
        const newId = (e.target as HTMLSelectElement).value;
        debugLog(`[KanbanWorkspaceViewComponent] Dropdown onChange: newId selected: ${newId}`);
        setSelectedViewId(newId); // Update child's own state first

        // Find the selected view object to get its name
        const selectedViewObject = (props.plugin.settings.savedWorkspaceViews || []).find(
          (v: SavedWorkspaceView) => v.id === newId
        );
        const viewName = selectedViewObject ? selectedViewObject.name : null;
        debugLog(
          `[KanbanWorkspaceViewComponent] Dropdown onChange: viewName determined: ${viewName} for newId: ${newId}`
        );

        // Directly tell the parent ItemView to set this configuration for the leaf
        if (newId) {
          // Only call if a valid view is selected
          props.view.setViewConfigurationForLeaf(viewName, newId);
        } else {
          props.view.setViewConfigurationForLeaf(null, null); // Clear view if "Select a view..." is chosen
        }
      }}
    >
      {/* Rest of the component code remains unchanged */}
    </select>
  );
};

export default KanbanWorkspaceViewComponent;
