import * as React from 'react';
import * as ReactDOM from 'react-dom';

interface ContentEditableProps2 {
  Component: React.ComponentType<any>;
  read: () => string;
  onChange: (s: string) => void;
}

export class ContentEditable2 extends React.Component<ContentEditableProps2, undefined> {
  automaticBlurTimeout: any;
  el: HTMLElement;

  // During normal operation, the content of the control is determined by the
  // props. But when the user focuses on the control, the control switches into
  // "editing" mode, where the content of the control is dictated by the by the
  // control itself and may be different from the props, until either the user
  // de-focuses, or presses enter, or a timeout expires and it automatically
  // de-focuses. The reason for this is React's poor support for managed content
  // of content-editable components (if you setState on each keystroke/change
  // then the cursor jumps to the end)
  //
  // In "editing" mode, if someone else makes a change to the same field, it
  // will be ignored (because the props will change but not the state).
  editingValue: string | undefined;

  constructor(props: ContentEditableProps2) {
    super(props);
  }

  resetAutomaticBlurTimeout = () => { this.stopAutomaticBlurTimeout(); this.startAutomaticBlurTimeout(); }

  startAutomaticBlurTimeout = () => this.automaticBlurTimeout = setTimeout(this.endEdit, 60_000)
  stopAutomaticBlurTimeout = () => clearTimeout(this.automaticBlurTimeout)

  componentWillUnmount = this.stopAutomaticBlurTimeout

  onInput: React.FormEventHandler = event => {
    this.el = event.target as HTMLElement;
    this.editingValue = this.el.textContent;
  }

  endEdit = () => {
    this.stopAutomaticBlurTimeout();

    // Remove selection, if the text was selected
    window.getSelection().removeAllRanges();

    const newValue = this.editingValue;

    // No longer editing
    this.editingValue = undefined;

    // At the end of the edit, the component switches back to "managed" mode,
    // where the displayed value must match the input props. The `onChange`
    // event should go back and update the props after this, but if it doesn't,
    // then at least the user can see that their change did not take effect
    this.el.textContent = this.props.read();

    const changed = newValue !== this.props.read();
    if (changed) {
      this.props.onChange(newValue);
    }
  }

  onFocus: React.FormEventHandler = event => {
    this.el = event.target as HTMLElement;
    const value = this.props.read();
    this.el.textContent = value;
    this.editingValue = value;
    this.selectAll(this.el);
  }

  selectAll = (el: HTMLElement) => {
    el.focus();

    setTimeout(selectRange, 1);
    selectRange();

    function selectRange() {
      // https://stackoverflow.com/a/3806004
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  onBlur = this.endEdit

  isEditing = () => this.editingValue !== undefined

  // There's a problem with "managed" content-editables. Every time they're
  // rendered, they seem to lose their cursor position. So I'm making it
  // unmanaged while the user is editing (typing)
  shouldComponentUpdate = () => {
    return !this.isEditing()
  }

  onKeyPress: React.KeyboardEventHandler = event => {
    const el = event.target as HTMLElement;
    this.editingValue = el.textContent;
    this.resetAutomaticBlurTimeout();

    // Enter pressed
    if (event.code === 'Enter') {
      el.blur();
      event.preventDefault();
    }
  }

  render = () =>
    <this.props.Component
      contentEditable={true}
      suppressContentEditableWarning={true}
      onInput={this.onInput}
      onFocus={this.onFocus}
      onBlur={this.onBlur}
      onKeyPress={this.onKeyPress}
      children={this.editingValue ?? this.props.read()}
    />
}