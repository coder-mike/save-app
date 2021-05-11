import * as React from 'react';
import * as ReactDOM from 'react-dom';
import 'react-dom';
import { createReadyIndicatorSvg, hideMobileNav, navListItemClick, renderCurrency, renderList, renderNavigator, signInClick, signOutClick, signUpClick } from './app';
import { AppMode, Currency, List, Snapshot, SyncStatus, UserInfo } from './data-model';
import { getAllocatedRate } from './utils';

// The "old" render pattern was a function that took in the state and returned
// the actual DOM elements. The new pattern is a react component class. Example:
//
// ```
// export const Page = oldRenderPatternToReact(renderPage, ref => <div ref={ref}/>);
// ```
function oldRenderPatternToReact<T>(
  oldStyle: (v: T) => HTMLElement | SVGElement,
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


export interface PageProps {
  snapshot: Snapshot;
  debugMode: boolean;
  syncStatus: SyncStatus;
  mode: AppMode;
  currentListIndex: number;
  userInfo: UserInfo;
}

function classes(...classes: string[]) {
  return classes
    .filter(Boolean)
    .join(' ') ;
}

export const Page = (p: PageProps) =>
  <div id='page' className={classes(p.syncStatus, p.mode, p.debugMode && 'debug-mode')}>
    <Navigator {...p}/>
    <ListComponent value={p.snapshot.lists[p.currentListIndex]} />
    <div id='mobile-nav-background' onClick={hideMobileNav} />
  </div>

export const Navigator = (p: PageProps) =>
  <div className='nav-panel'>
    <UserPanel {...p} />
    <div className="lists-section">
      <ul className="list-nav">
        {p.snapshot.lists.map((list, i) =>
          <NavigatorItem list={list} isActive={i === p.currentListIndex}/>)}
      </ul>
    </div>
  </div>

export const NavigatorItem = ({ list, isActive }: { list: List, isActive: boolean }) => {
  const listHasReadyItems = list.items.some(item => item.saved.value && item.saved.value >= item.price);
  const allocatedAmount = Math.round(getAllocatedRate(list.budget) * 365.25 / 12);

  return (
    <li
      className={classes('nav-item', listHasReadyItems && 'has-ready-items', isActive && 'active')}
      onClick={navListItemClick}
    >
      <h1>{list.name}</h1>
      { listHasReadyItems
          ? <ReadyIndicatorSvg value={null} />
          : undefined }
      { allocatedAmount
          ? <CurrencyComponent className='allocated' value={allocatedAmount}/>
          : undefined }
    </li> )
}

export const UserPanel = ({ userInfo, mode, syncStatus }: PageProps) =>
  mode === 'online'
    ? <div className='user-panel'>
        <div className='user-status'>
          {syncStatus !== 'sync-failure'
            ? `Hi, ${userInfo.name}`
            : 'Connection error'}
        </div>
        <div className="user-panel-buttons">
          <button className='sign-out' onClick={signOutClick}>Sign out</button>
        </div>
      </div>
    : <div className='user-panel'>
        <div className='user-status'>
          Your lists are currently stored locally
        </div>
        <div className="user-panel-buttons">
          <button className='sign-up' onClick={signUpClick}>New account</button>
          <button className='sign-in' onClick={signInClick}>Sign in</button>
        </div>
      </div>

export const CurrencyComponent = ({ amount, decimals, className }: { amount: Currency, decimals?: number, className?: string }) =>

   <span className={classes(className, 'currency')}>{formatCurrency(amount, decimals)}</span>


export const ListComponent = oldRenderPatternToReact(renderList, ref => <div ref={ref}/>);
export const ReadyIndicatorSvg = oldRenderPatternToReact(createReadyIndicatorSvg, ref => <svg ref={ref}/>);