import * as React from 'react';
import * as ReactDOM from 'react-dom';
import 'react-dom';
import { renderList, renderNavigator, renderPage } from './app';
import { AppMode, Snapshot, SyncStatus } from './data-model';

// The "old" render pattern was a function that took in the state and returned
// the actual DOM elements. The new pattern is a react component class. Example:
//
// ```
// export const Page = oldRenderPatternToReact(renderPage, ref => <div ref={ref}/>);
// ```
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


export interface PageState {
  snapshot: Snapshot;
  debugMode: boolean;
  syncStatus: SyncStatus;
  mode: AppMode;
  currentListIndex: number;
}

function classes(...classes: string[]) {
  return classes
    .filter(Boolean)
    .join(' ') ;
}

export const Page = ({ snapshot, debugMode, syncStatus, mode, currentListIndex }: PageState) =>
  <div id='page' className={classes(syncStatus, mode, debugMode && 'debug-mode')}>
    <Navigator value={snapshot}/>
    <List value={snapshot.lists[currentListIndex]}/>
    <div id='mobile-nav-background' onClick={hideMobileNav}/>
  </div>

function hideMobileNav() {
  document.getElementById('page').classList.remove('mobile-nav-showing');
}

export const Navigator = oldRenderPatternToReact(renderNavigator, ref => <div ref={ref}/>);
export const List = oldRenderPatternToReact(renderList, ref => <div ref={ref}/>);
