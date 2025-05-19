import { colord } from 'colord';
import update from 'immutability-helper';
import {
  render,
  unmountComponentAtNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'preact/compat';
import useOnclickOutside from 'react-cool-onclickoutside';

import { Icon } from '../components/Icon/Icon';
import { c, generateInstanceId } from '../components/helpers';
import {
  DataTypes,
  TagSymbol,
  TagSymbolSetting,
  TagSymbolSettingTemplate,
} from '../components/types';
import { getParentBodyElement } from '../dnd/util/getWindow';
import { t } from '../lang/helpers';

interface ItemProps {
  deleteKey: () => void;
  tagSymbolKey: TagSymbol | null | undefined;
  updateKey: (tagKey: string, symbol: string) => void;
}

function SymbolPicker({
  symbol,
  setSymbol,
  onClose,
}: {
  symbol: string;
  setSymbol: (symbol: string) => void;
  onClose: () => void;
}) {
  // A very basic emoji picker for demonstration.
  // In a real scenario, you might use a library or a more extensive list.
  const commonSymbols = ['💼', '🏠', '✈️', '⭐', '❤️', '✅', '❌', '💡', '📅', '⏰'];
  const ref = useOnclickOutside(onClose);

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        background: 'var(--background-secondary)',
        border: '1px solid var(--background-modifier-border)',
        borderRadius: '4px',
        padding: '8px',
        zIndex: 100,
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px',
        width: '150px',
      }}
    >
      {commonSymbols.map((s) => (
        <button
          key={s}
          onClick={() => {
            setSymbol(s);
            onClose();
          }}
          style={{
            cursor: 'pointer',
            padding: '4px',
            border: 'none',
            background: 'var(--background-primary)',
            borderRadius: '4px',
          }}
        >
          {s}
        </button>
      ))}
    </div>
  );
}

function Item({ tagSymbolKey, deleteKey, updateKey }: ItemProps) {
  const [showPicker, setShowPicker] = useState(false);

  const currentTagKey = tagSymbolKey?.tagKey || '';
  const currentSymbol = tagSymbolKey?.symbol || '';

  return (
    <div className={c('setting-item-wrapper')}>
      <div className={c('setting-item')}>
        <div className={`${c('setting-controls-wrapper')} ${c('tag-symbol-input')}`}>
          <div className={c('setting-input-wrapper')}>
            <div>
              <div className={c('setting-item-label')}>{t('Tag')}</div>
              <input
                type="text"
                placeholder="#tag"
                value={currentTagKey}
                onChange={(e) => {
                  const val = e.currentTarget.value;
                  updateKey(val[0] === '#' ? val : '#' + val, currentSymbol);
                }}
              />
            </div>
            <div style={{ position: 'relative' }}>
              <div className={c('setting-item-label')}>{t('Symbol')}</div>
              <input
                type="text"
                placeholder="🏷️"
                value={currentSymbol}
                onFocus={() => setShowPicker(true)}
                onChange={(e) => {
                  updateKey(currentTagKey, e.currentTarget.value);
                }}
              />
              {showPicker && (
                <SymbolPicker
                  symbol={currentSymbol}
                  setSymbol={(symbol) => updateKey(currentTagKey, symbol)}
                  onClose={() => setShowPicker(false)}
                />
              )}
            </div>
          </div>
          <div className={c('setting-toggle-wrapper')}>
            <div>
              <div className={c('item-tags')}>
                <a className={`tag ${c('item-tag')}`}>
                  <span>{currentSymbol || '🏷️'}</span>
                  {(currentTagKey || '#tag').slice(1)}
                </a>
              </div>
            </div>
          </div>
        </div>
        <div className={c('setting-button-wrapper')}>
          <div className="clickable-icon" onClick={deleteKey} aria-label={t('Delete')}>
            <Icon name="lucide-trash-2" />
          </div>
        </div>
      </div>
    </div>
  );
}

interface TagSymbolSettingsProps {
  dataKeys: TagSymbolSetting[];
  onChange: (settings: TagSymbolSetting[]) => void;
  portalContainer: HTMLElement; // Not strictly needed if not using DragOverlay from dnd
}

function TagSymbolSettings({ dataKeys, onChange }: TagSymbolSettingsProps) {
  const [keys, setKeys] = useState(() => {
    return (dataKeys || [])
      .filter((k) => k && typeof k.id === 'string') // Ensure item and its id are valid
      .map((k) => ({
        id: k.id,
        type: k.type === DataTypes.TagSymbolSetting ? k.type : DataTypes.TagSymbolSetting, // Ensure it uses TagSymbolSetting
        accepts: Array.isArray(k.accepts) ? k.accepts : [], // Default accepts if not an array
        children: Array.isArray(k.children) ? k.children : [], // Default children if not an array
        data:
          k.data && typeof k.data.tagKey === 'string' && typeof k.data.symbol === 'string' // Changed from .emoji to .symbol
            ? k.data
            : { tagKey: '', symbol: '' }, // Changed from .emoji to .symbol
      }));
  });

  const updateKeys = (newKeys: TagSymbolSetting[]) => {
    onChange(newKeys);
    setKeys(newKeys);
  };

  const newKey = () => {
    updateKeys(
      update(keys, {
        $push: [
          {
            ...TagSymbolSettingTemplate,
            id: generateInstanceId(),
            data: {
              // Ensure data is initialized as per TagEmoji
              tagKey: '',
              symbol: '', // Changed from .emoji to .symbol
            },
          },
        ],
      })
    );
  };

  const deleteKey = (i: number) => {
    updateKeys(
      update(keys, {
        $splice: [[i, 1]],
      })
    );
  };

  const updateTagSymbol = (i: number) => (tagKey: string, symbol: string) => {
    updateKeys(
      update(keys, {
        [i]: {
          data: {
            tagKey: { $set: tagKey },
            symbol: { $set: symbol }, // Changed from .emoji to .symbol
          },
        },
      })
    );
  };

  return (
    <div className={c('tag-symbol-input-wrapper')}>
      <div className="setting-item-info">
        <div className="setting-item-name">{t('Tag Symbols')}</div>
        <div className="setting-item-description">
          {t('Set symbols for tags displayed in cards.')}
        </div>
        <br></br>
      </div>
      <div>
        {keys.map((key, index) => (
          <Item
            key={key.id}
            tagSymbolKey={key.data}
            deleteKey={() => deleteKey(index)}
            updateKey={updateTagSymbol(index)}
          />
        ))}
      </div>
      <br></br>
      <button
        className={c('add-tag-symbol-button')}
        onClick={() => {
          newKey();
        }}
      >
        {t('Add tag symbol')}
      </button>
    </div>
  );
}

export function renderTagSymbolSettings(
  containerEl: HTMLElement,
  keys: TagSymbolSetting[],
  onChange: (key: TagSymbolSetting[]) => void
) {
  render(
    <TagSymbolSettings
      dataKeys={keys}
      onChange={onChange}
      portalContainer={getParentBodyElement(containerEl)} // May not be needed if no DragOverlay
    />,
    containerEl
  );
}

export function unmountTagSymbolSettings(containerEl: HTMLElement) {
  unmountComponentAtNode(containerEl);
}
