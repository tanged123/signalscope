/**
 * Configuration dialog for creating and editing annotations
 *
 * Provides a modal dialog for setting annotation properties:
 * - Label, color, line style, line width (for lines)
 * - Text content, color, font size (for text annotations)
 * - Label, color, marker size (for point annotations)
 */

import type { AnnotationConfig } from '../config/types.js';

export interface AnnotationConfigDialogOptions {
  readonly palette?: readonly string[];
  readonly zIndex?: number;
}

export interface AnnotationConfigDialog {
  showCreate(
    annotationType: 'lineX' | 'lineY' | 'text' | 'point',
    defaults: Partial<AnnotationConfig>,
    onSave: (config: AnnotationConfig) => void,
    onCancel: () => void
  ): void;

  showEdit(
    annotation: AnnotationConfig,
    onSave: (updates: Partial<AnnotationConfig>) => void,
    onCancel: () => void
  ): void;

  hide(): void;
  dispose(): void;
}

const HIGH_CONTRAST_PALETTE = [
  '#ef4444', // Red (critical)
  '#f97316', // Orange (warning)
  '#eab308', // Yellow (caution)
  '#22c55e', // Green (success)
  '#06b6d4', // Cyan (info)
  '#3b82f6', // Blue (primary)
  '#8b5cf6', // Purple (accent)
  '#ec4899', // Pink (highlight)
  '#ffffff', // White (high contrast)
  '#94a3b8', // Gray (neutral)
  '#64748b', // Dark gray (subtle)
  '#1e293b', // Near-black (background)
] as const;

/**
 * Creates a configuration dialog for annotations
 */
export function createAnnotationConfigDialog(
  container: HTMLElement,
  options: AnnotationConfigDialogOptions = {}
): AnnotationConfigDialog {
  const palette = options.palette ?? HIGH_CONTRAST_PALETTE;
  const zIndex = options.zIndex ?? 1000;

  let overlay: HTMLDivElement | null = null;
  let dialog: HTMLDivElement | null = null;
  let currentOnSave: ((config: any) => void) | null = null;
  let currentOnCancel: (() => void) | null = null;
  let mode: 'create' | 'edit' = 'create';

  /**
   * Create the modal overlay
   */
  function createOverlay(): HTMLDivElement {
    const div = document.createElement('div');
    div.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.4);
      z-index: ${zIndex + 1};
      display: flex;
      align-items: center;
      justify-content: center;
    `;
    div.addEventListener('click', (e) => {
      if (e.target === div) {
        handleCancel();
      }
    });
    return div;
  }

  /**
   * Create the dialog box
   */
  function createDialog(): HTMLDivElement {
    const div = document.createElement('div');
    div.style.cssText = `
      width: 320px;
      background: #1a1a2e;
      border: 1px solid #333;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.7);
      padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #e0e0e0;
    `;
    return div;
  }

  /**
   * Create a form field container
   */
  function createField(label: string, input: HTMLElement): HTMLDivElement {
    const field = document.createElement('div');
    field.style.cssText = `
      margin-bottom: 16px;
    `;

    const labelEl = document.createElement('label');
    labelEl.textContent = label;
    labelEl.style.cssText = `
      display: block;
      margin-bottom: 8px;
      font-size: 13px;
      font-weight: 500;
      color: #b0b0b0;
    `;

    field.appendChild(labelEl);
    field.appendChild(input);
    return field;
  }

  /**
   * Create a text input
   */
  function createTextInput(placeholder: string, maxLength: number, defaultValue = ''): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = placeholder;
    input.maxLength = maxLength;
    input.value = defaultValue;
    input.style.cssText = `
      width: 100%;
      padding: 8px 12px;
      background: #2a2a3e;
      border: 1px solid #444;
      border-radius: 4px;
      color: #e0e0e0;
      font-size: 14px;
      box-sizing: border-box;
    `;
    input.addEventListener('focus', () => {
      input.style.borderColor = '#3b82f6';
    });
    input.addEventListener('blur', () => {
      input.style.borderColor = '#444';
    });
    return input;
  }

  /**
   * Create a textarea
   */
  function createTextArea(placeholder: string, maxLength: number, defaultValue = ''): HTMLTextAreaElement {
    const textarea = document.createElement('textarea');
    textarea.placeholder = placeholder;
    textarea.maxLength = maxLength;
    textarea.value = defaultValue;
    textarea.rows = 3;
    textarea.style.cssText = `
      width: 100%;
      padding: 8px 12px;
      background: #2a2a3e;
      border: 1px solid #444;
      border-radius: 4px;
      color: #e0e0e0;
      font-size: 14px;
      box-sizing: border-box;
      resize: vertical;
      font-family: inherit;
    `;
    textarea.addEventListener('focus', () => {
      textarea.style.borderColor = '#3b82f6';
    });
    textarea.addEventListener('blur', () => {
      textarea.style.borderColor = '#444';
    });
    return textarea;
  }

  /**
   * Create a color picker grid
   */
  function createColorPicker(selectedColor: string): {
    container: HTMLDivElement;
    getValue: () => string;
  } {
    const container = document.createElement('div');
    container.style.cssText = `
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
    `;

    let currentColor = selectedColor;

    palette.forEach((color) => {
      // Button wrapper for swatch
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.dataset.color = color; // Store color for reliable comparison
      swatch.style.cssText = `
        position: relative;
        width: 100%;
        aspect-ratio: 1;
        background: ${color};
        border: none;
        border-radius: 4px;
        cursor: pointer;
        transition: transform 0.15s ease-out, box-shadow 0.15s ease-out;
        box-shadow: ${color === currentColor ? 'inset 0 0 0 2px #ffffff, inset 0 0 0 3px rgba(0, 0, 0, 0.3), 0 2px 8px rgba(0, 0, 0, 0.3)' : 'inset 0 0 0 1px rgba(255, 255, 255, 0.1)'};
        transform: ${color === currentColor ? 'scale(1.05)' : 'scale(1)'};
      `;

      // Create checkmark SVG for selected state
      const checkmark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      checkmark.setAttribute('viewBox', '0 0 24 24');
      checkmark.setAttribute('fill', 'none');
      checkmark.style.cssText = `
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 60%;
        height: 60%;
        pointer-events: none;
        opacity: ${color === currentColor ? '1' : '0'};
        transition: opacity 0.15s ease-out;
      `;

      // Checkmark path with dual stroke for maximum contrast
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M20 6L9 17l-5-5');
      path.setAttribute('stroke', '#ffffff');
      path.setAttribute('stroke-width', '3');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.style.cssText = `
        filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.8)) drop-shadow(0 0 1px rgba(0, 0, 0, 0.9));
      `;

      checkmark.appendChild(path);
      swatch.appendChild(checkmark);

      // Click handler
      swatch.addEventListener('click', () => {
        currentColor = color;
        // Update all swatches
        Array.from(container.children).forEach((child) => {
          const btn = child as HTMLButtonElement;
          const btnColor = btn.dataset.color; // Use data attribute for reliable comparison
          const isSelected = btnColor === color;

          // Update box-shadow for border effect
          btn.style.boxShadow = isSelected
            ? 'inset 0 0 0 2px #ffffff, inset 0 0 0 3px rgba(0, 0, 0, 0.3), 0 2px 8px rgba(0, 0, 0, 0.3)'
            : 'inset 0 0 0 1px rgba(255, 255, 255, 0.1)';

          // Update scale
          btn.style.transform = isSelected ? 'scale(1.05)' : 'scale(1)';

          // Update checkmark visibility
          const svg = btn.querySelector('svg');
          if (svg) {
            svg.style.opacity = isSelected ? '1' : '0';
          }
        });
      });

      // Hover effects
      swatch.addEventListener('mouseenter', () => {
        if (color !== currentColor) {
          swatch.style.transform = 'scale(1.1)';
          swatch.style.boxShadow = 'inset 0 0 0 2px rgba(255, 255, 255, 0.2), 0 4px 12px rgba(0, 0, 0, 0.4)';
        }
      });

      swatch.addEventListener('mouseleave', () => {
        if (color !== currentColor) {
          swatch.style.transform = 'scale(1)';
          swatch.style.boxShadow = 'inset 0 0 0 1px rgba(255, 255, 255, 0.1)';
        }
      });

      container.appendChild(swatch);
    });

    return {
      container,
      getValue: () => currentColor,
    };
  }

  /**
   * Create a dropdown select
   */
  function createDropdown(
    options: Array<{ label: string; value: string }>,
    defaultValue: string
  ): { container: HTMLSelectElement; getValue: () => string } {
    const select = document.createElement('select');
    select.style.cssText = `
      width: 100%;
      padding: 8px 12px;
      background: #2a2a3e;
      border: 1px solid #444;
      border-radius: 4px;
      color: #e0e0e0;
      font-size: 14px;
      cursor: pointer;
    `;

    options.forEach((opt) => {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      if (opt.value === defaultValue) {
        option.selected = true;
      }
      select.appendChild(option);
    });

    return {
      container: select,
      getValue: () => select.value,
    };
  }

  /**
   * Create a slider with numeric value display
   */
  function createSlider(
    min: number,
    max: number,
    step: number,
    defaultValue: number,
    unit = ''
  ): { container: HTMLDivElement; getValue: () => number } {
    const container = document.createElement('div');
    container.style.cssText = `
      display: flex;
      align-items: center;
      gap: 12px;
    `;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(defaultValue);
    slider.style.cssText = `
      flex: 1;
      cursor: pointer;
    `;

    const valueDisplay = document.createElement('span');
    valueDisplay.textContent = `${defaultValue}${unit}`;
    valueDisplay.style.cssText = `
      min-width: 40px;
      text-align: right;
      font-size: 13px;
      color: #b0b0b0;
    `;

    slider.addEventListener('input', () => {
      valueDisplay.textContent = `${slider.value}${unit}`;
    });

    container.appendChild(slider);
    container.appendChild(valueDisplay);

    return {
      container,
      getValue: () => parseFloat(slider.value),
    };
  }

  /**
   * Create action buttons
   */
  function createButtons(saveLabel: string, onSaveClick: () => void, onCancelClick: () => void): HTMLDivElement {
    const container = document.createElement('div');
    container.style.cssText = `
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      margin-top: 24px;
    `;

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = `
      padding: 8px 16px;
      background: transparent;
      border: 1px solid #444;
      border-radius: 4px;
      color: #888;
      font-size: 14px;
      cursor: pointer;
      transition: background 0.15s;
    `;
    cancelBtn.addEventListener('mouseenter', () => {
      cancelBtn.style.background = '#2a2a3e';
    });
    cancelBtn.addEventListener('mouseleave', () => {
      cancelBtn.style.background = 'transparent';
    });
    cancelBtn.addEventListener('click', onCancelClick);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = saveLabel;
    saveBtn.style.cssText = `
      padding: 8px 16px;
      background: #2a2a3e;
      border: 1px solid #444;
      border-radius: 4px;
      color: #e0e0e0;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
    `;
    saveBtn.addEventListener('mouseenter', () => {
      saveBtn.style.background = '#3a3a4e';
    });
    saveBtn.addEventListener('mouseleave', () => {
      saveBtn.style.background = '#2a2a3e';
    });
    saveBtn.addEventListener('click', onSaveClick);

    container.appendChild(cancelBtn);
    container.appendChild(saveBtn);

    return container;
  }

  /**
   * Build form for line annotations (lineX/lineY)
   */
  function buildLineForm(defaults: Partial<AnnotationConfig>): HTMLDivElement {
    const form = document.createElement('div');

    // Extract label text from label object (if it exists)
    const defaultLabelText = (defaults as any).label?.text ?? '';
    const labelInput = createTextInput('Line label', 100, defaultLabelText);
    const colorPicker = createColorPicker(defaults.style?.color ?? palette[0]);
    const lineStyleDropdown = createDropdown(
      [
        { label: 'Solid', value: 'solid' },
        { label: 'Dashed', value: 'dashed' },
        { label: 'Dotted', value: 'dotted' },
      ],
      defaults.style?.lineDash ? (defaults.style.lineDash.length === 4 ? 'dashed' : 'dotted') : 'solid'
    );
    const lineWidthSlider = createSlider(1, 8, 1, defaults.style?.lineWidth ?? 2, 'px');

    form.appendChild(createField('Label (optional)', labelInput));
    form.appendChild(createField('Color', colorPicker.container));
    form.appendChild(createField('Line Style', lineStyleDropdown.container));
    form.appendChild(createField('Line Width', lineWidthSlider.container));

    const buttons = createButtons(
      mode === 'create' ? 'Create' : 'Save',
      () => {
        const lineDashMap: Record<string, number[] | undefined> = {
          solid: undefined,
          dashed: [4, 4],
          dotted: [2, 2],
        };

        const labelText = labelInput.value.trim();
        const config: Partial<AnnotationConfig> = {
          ...defaults,
          label: labelText
            ? {
                ...(defaults as any).label,
                text: labelText,
              }
            : undefined,
          style: {
            ...defaults.style,
            color: colorPicker.getValue(),
            lineWidth: lineWidthSlider.getValue(),
            lineDash: lineDashMap[lineStyleDropdown.getValue()],
          },
        };

        handleSave(config);
      },
      () => handleCancel()
    );

    form.appendChild(buttons);

    return form;
  }

  /**
   * Build form for text annotations
   */
  function buildTextForm(defaults: Partial<AnnotationConfig>): HTMLDivElement {
    const form = document.createElement('div');

    // Extract text from text annotation
    const defaultText = (defaults as any).text ?? '';
    const textArea = createTextArea('Text content', 500, defaultText);
    const colorPicker = createColorPicker(defaults.style?.color ?? palette[0]);

    form.appendChild(createField('Text', textArea));
    form.appendChild(createField('Color', colorPicker.container));

    const buttons = createButtons(
      mode === 'create' ? 'Create' : 'Save',
      () => {
        const text = textArea.value.trim();
        if (!text) {
          textArea.style.borderColor = '#ef4444';
          textArea.focus();
          return;
        }

        const config: Partial<AnnotationConfig> = {
          ...defaults,
          text,
          style: {
            ...defaults.style,
            color: colorPicker.getValue(),
          },
        } as any; // Use 'any' to bypass type narrowing issues

        handleSave(config);
      },
      () => handleCancel()
    );

    form.appendChild(buttons);

    return form;
  }

  /**
   * Build form for point annotations
   */
  function buildPointForm(defaults: Partial<AnnotationConfig>): HTMLDivElement {
    const form = document.createElement('div');

    // Extract label text from label object (if it exists)
    const defaultLabelText = (defaults as any).label?.text ?? '';
    const labelInput = createTextInput('Point label', 100, defaultLabelText);
    const colorPicker = createColorPicker(defaults.style?.color ?? palette[0]);

    // For point annotations, marker style might be in marker.style or just style
    const defaultMarkerSize = (defaults as any).marker?.size ?? (defaults as any).marker?.style?.markerSize ?? 8;
    const markerSizeSlider = createSlider(4, 16, 1, defaultMarkerSize, 'px');

    form.appendChild(createField('Label (optional)', labelInput));
    form.appendChild(createField('Color', colorPicker.container));
    form.appendChild(createField('Marker Size', markerSizeSlider.container));

    const buttons = createButtons(
      mode === 'create' ? 'Create' : 'Save',
      () => {
        const labelText = labelInput.value.trim();
        const config: Partial<AnnotationConfig> = {
          ...defaults,
          label: labelText
            ? {
                ...(defaults as any).label,
                text: labelText,
              }
            : undefined,
          marker: {
            ...(defaults as any).marker,
            size: markerSizeSlider.getValue(),
            style: {
              ...(defaults as any).marker?.style,
              color: colorPicker.getValue(),
            },
          },
        };

        handleSave(config);
      },
      () => handleCancel()
    );

    form.appendChild(buttons);

    return form;
  }

  /**
   * Handle save action
   */
  function handleSave(config: any): void {
    if (currentOnSave) {
      currentOnSave(config);
    }
    hide();
  }

  /**
   * Handle cancel action
   */
  function handleCancel(): void {
    if (currentOnCancel) {
      currentOnCancel();
    }
    hide();
  }

  /**
   * Handle keyboard events
   */
  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  }

  /**
   * Show dialog for creating a new annotation
   */
  function showCreate(
    type: 'lineX' | 'lineY' | 'text' | 'point',
    defaults: Partial<AnnotationConfig>,
    onSave: (config: AnnotationConfig) => void,
    onCancel: () => void
  ): void {
    mode = 'create';
    currentOnSave = onSave;
    currentOnCancel = onCancel;

    overlay = createOverlay();
    dialog = createDialog();

    const title = document.createElement('h3');
    title.textContent = `Add ${type === 'lineX' ? 'Vertical Line' : type === 'lineY' ? 'Horizontal Line' : type === 'text' ? 'Text Note' : 'Point Marker'}`;
    title.style.cssText = `
      margin: 0 0 20px 0;
      font-size: 16px;
      font-weight: 600;
      color: #ffffff;
    `;
    dialog.appendChild(title);

    let form: HTMLDivElement;
    if (type === 'lineX' || type === 'lineY') {
      form = buildLineForm(defaults);
    } else if (type === 'text') {
      form = buildTextForm(defaults);
    } else {
      form = buildPointForm(defaults);
    }

    dialog.appendChild(form);
    overlay.appendChild(dialog);
    container.appendChild(overlay);

    document.addEventListener('keydown', handleKeyDown);

    // Focus first input
    const firstInput = dialog.querySelector('input, textarea') as HTMLElement;
    if (firstInput) {
      setTimeout(() => firstInput.focus(), 50);
    }
  }

  /**
   * Show dialog for editing an existing annotation
   */
  function showEdit(
    annotation: AnnotationConfig,
    onSave: (updates: Partial<AnnotationConfig>) => void,
    onCancel: () => void
  ): void {
    mode = 'edit';
    currentOnSave = onSave;
    currentOnCancel = onCancel;

    overlay = createOverlay();
    dialog = createDialog();

    const title = document.createElement('h3');
    title.textContent = 'Edit Annotation';
    title.style.cssText = `
      margin: 0 0 20px 0;
      font-size: 16px;
      font-weight: 600;
      color: #ffffff;
    `;
    dialog.appendChild(title);

    let form: HTMLDivElement;
    if (annotation.type === 'lineX' || annotation.type === 'lineY') {
      form = buildLineForm(annotation);
    } else if (annotation.type === 'text') {
      form = buildTextForm(annotation);
    } else {
      form = buildPointForm(annotation);
    }

    dialog.appendChild(form);
    overlay.appendChild(dialog);
    container.appendChild(overlay);

    document.addEventListener('keydown', handleKeyDown);

    // Focus first input
    const firstInput = dialog.querySelector('input, textarea') as HTMLElement;
    if (firstInput) {
      setTimeout(() => firstInput.focus(), 50);
    }
  }

  /**
   * Hide the dialog
   */
  function hide(): void {
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    overlay = null;
    dialog = null;
    currentOnSave = null;
    currentOnCancel = null;

    document.removeEventListener('keydown', handleKeyDown);
  }

  /**
   * Dispose of resources
   */
  function dispose(): void {
    hide();
  }

  return {
    showCreate,
    showEdit,
    hide,
    dispose,
  };
}
