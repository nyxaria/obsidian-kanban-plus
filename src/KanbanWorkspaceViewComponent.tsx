import React, { useEffect, useState } from 'react';

const KanbanWorkspaceViewComponent = (props) => {
  const [selectedViewId, setSelectedViewId] = useState(props.selectedViewId);
  const [currentPluginSettings, setCurrentPluginSettings] = useState(props.plugin.settings);
  const [newGlobalLastSelectedId, setNewGlobalLastSelectedId] = useState(props.plugin.settings.lastSelectedWorkspaceViewId);
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
    // Rest of the component code remains unchanged
  );
};

export default KanbanWorkspaceViewComponent; 