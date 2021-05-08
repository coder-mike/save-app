import * as React from 'react';
import * as ReactDOM from 'react-dom';
import 'react-dom';
import { renderPage, Snapshot } from './app';

// The "old" render pattern was a function that took in the state and returned
// the actual DOM elements. The new pattern is a react component class.
function oldRenderPatternToReact<T>(
  oldStyle: (v: T) => HTMLElement,
  container: any,
) {
  return class extends React.Component<{ value: T }> {
    elRef = React.createRef();

    render() {
      return container(this.elRef);
    }

    componentDidMount() {
      this.updateDom();
    }

    componentDidUpdate() {
      this.updateDom();
    }

    updateDom() {
      // Render using "the old style"
      const oldStyleDom = oldStyle(this.props.value);
      const el = this.elRef.current as HTMLElement;

      // Copy state of old style rendering into new container
      el.id = oldStyleDom.id;
      el.classList.forEach(c => el.classList.remove(c));
      oldStyleDom.classList.forEach(c => el.classList.add(c));
      (el as any).replaceChildren(...(oldStyleDom.children as any));
    }
  }
}

export const Page = oldRenderPatternToReact(renderPage, ref => <div ref={ref as any}/>);
