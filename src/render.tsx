import * as React from 'react';
import * as ReactDOM from 'react-dom';
import 'react-dom';
import { addUserAction, renderListMenu, createReadyIndicatorSvg, deserializeDate, getList, Globals, hideMobileNav, navListItemClick, parseNonNegativeCurrency, rateInDollarsPerMs, renderCurrency, renderList, renderMobileTopMenuBar, renderNavigator, signInClick, signOutClick, signUpClick } from './app';
import { AppMode, Currency, LinearAmount, List as WishList, Snapshot, SyncStatus, UserInfo } from './data-model';
import { getAllocatedRate } from './utils';

const svgNs = 'http://www.w3.org/2000/svg';

const SnapshotTimeContext = React.createContext({ snapshotTime: undefined as number });

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
  return class extends React.Component<{ value?: T }> {
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

const classes = (...classes: string[]) =>
  classes
    .filter(Boolean)
    .join(' ')

export const Page = (p: PageProps) =>
  <SnapshotTimeContext.Provider value={{ snapshotTime: deserializeDate(p.snapshot.time) }}>
    <div id='page' className={classes(p.syncStatus, p.mode, p.debugMode && 'debug-mode')}>
      <Navigator {...p}/>
      <WishListComponent list={p.snapshot.lists[p.currentListIndex]} />
      <div id='mobile-nav-background' onClick={hideMobileNav} />
    </div>
  </SnapshotTimeContext.Provider>

const Navigator = (p: PageProps) =>
  <div className='nav-panel'>
    <UserPanel {...p} />
    <div className="lists-section">
      <ul className="list-nav">
        {p.snapshot.lists.map((list, i) =>
          <NavigatorItem key={list.id} list={list} isActive={i === p.currentListIndex}/>)}
      </ul>
    </div>
  </div>

const NavigatorItem = ({ list, isActive }: { list: WishList, isActive: boolean }) => {
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
          ? <CurrencyComponent className='allocated' amount={allocatedAmount}/>
          : undefined }
    </li> )
}

const UserPanel = ({ userInfo, mode, syncStatus }: PageProps) =>
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

const CurrencyComponent = ({ amount, decimals, className }: { amount: Currency, decimals?: number, className?: string }) =>
   <span className={classes(className, 'currency')}>{formatCurrency(amount, decimals)}</span>

const WishListComponent = ({ list }: { list: WishList }) =>
  <div id='current-list' className='list'>
    { /* TODO: attach domDataAttachments for events */ }
    <ListHeader list={list} />
    <ol className="purchase-history">
      {/* TODO */}
    </ol>
    <ol className="items-list">
      {/* TODO */}
    </ol>
    <button className="add-item svg-button">
      {/* TODO: Click handler */}
      <PlusSvg />
    </button>
  </div>

const ListHeader = ({ list }: { list: WishList }) =>
  <div className='list-sticky-area'>
    <SquirrelGraphic />
    <MobileTopMenuBar value={undefined} />
    <div className="list-header">
      <ListName list={list} />
      <div className="list-info">
        <ListHeaderAllocated list={list} />
        {showKitty(list.kitty) && <ListKitty kitty={list.kitty} />}
      </div>
      <ListMenuComponent />
    </div>
  </div>

const showKitty = (kitty: LinearAmount) => kitty.value !== 0 || kitty.rate !== 0;

const ListKitty = ({ kitty }: { kitty: LinearAmount }) =>
  <span className="list-overflow">
    {kitty.value >= 0
      ? <LinearAmountComponent money={kitty}/>
      : <LinearAmountComponent
          className='debt'
          money={{
            value: -kitty.value,
            rate: -kitty.rate
          }}
        />
    }
  </span>

const ListHeaderAllocated = ({ list }: { list: WishList }) =>
  <div className="list-allocated">
    <ContentEditable
      Component={() => <div className="allocated-amount" />}
      read={() => formatCurrency(getList(list.id).budget.dollars)}
      write={v => addUserAction({
        type: 'ListSetBudget',
        listId: list.id,
        budget: { dollars: parseNonNegativeCurrency(v), unit: '/month' }
      })}
    />
    <div className="allocated-unit">{list.budget.unit}</div>
  </div>

const ListName = ({ list }: { list: WishList }) =>
  <div className='list-name'>
    <ContentEditable
      Component={() => <h1 id='list-heading' className='list-heading' />}
      read={() => getList(list.id).name}
      write={value => addUserAction({ type: 'ListSetName', listId: list.id, newName: value })}
      requiresRender={false}
    />
  </div>

const ReadyIndicatorSvg = oldRenderPatternToReact(createReadyIndicatorSvg, ref => <svg ref={ref}/>);

export function formatCurrency(value: Currency, decimals = 2) {
  return value.toFixed(decimals);
}

interface ContentEditableProps {
  Component: React.ComponentType<{ onChange: React.FormEventHandler }>;
  read: () => string;
  // TODO: it would be better if our react components didn't have side effects
  write: (s: string) => void;
  requiresRender?: boolean;
}

class ContentEditable extends React.Component<ContentEditableProps, { value: string }> {
  constructor(props: ContentEditableProps) {
    super(props);
    this.state = { value: props.read() }
  }

  onChange: React.FormEventHandler = event => {
    this.props.write((event.target as any).textContent);
    this.setState({ value: this.props.read() });
  }

  render = () =>
    <this.props.Component onChange={this.onChange}>
      {this.state.value}
    </this.props.Component>
}

interface LinearAmountProps {
  money: LinearAmount;
  className?: string;
}

const LinearAmountComponent = (p: LinearAmountProps) =>
  p.money.rate
    ? <StaticMoney {...p}/>
    : <LinearChangingMoney {...p} />

const StaticMoney = (p: LinearAmountProps) =>
  <span className={classes('money', p.className)}>
    <span className='main-amount'>{formatCurrency(p.money.value)}</span>
  </span>

class LinearChangingMoney extends React.Component<LinearAmountProps, { now: number }> {
  timer: any;
  static contextType = SnapshotTimeContext
  context!: React.ContextType<typeof SnapshotTimeContext>

  constructor(props: LinearChangingMoney['props']) {
    super(props);
    this.state = { now: Date.now()}
  }

  // The amount of time it takes to tick 100th of 1 cent
  interval = () => 86400000 / (this.props.money.rate * 10000)

  onTimerTick = () => this.setState({ now: Date.now() })

  startTimer = () => this.timer = setInterval(this.onTimerTick, this.interval())
  stopTimer = () => clearInterval(this.timer)
  restartTimer = () => { this.startTimer(); this.stopTimer(); }

  componentDidMount = this.startTimer
  componentDidUpdate = this.restartTimer // Interval may have changed
  componentWillUnmount = this.stopTimer

  render() {
    const { rate, value } = this.props.money;
    const valueNow = value + rateInDollarsPerMs(rate) * (this.state.now - this.context.snapshotTime);
    const text = valueNow.toFixed(4)

    return (
      <span className={classes('money', this.props.className)}>
        <span className='main-amount'>{text.slice(0, text.length - 2)}</span>
        <span className='sub-cents'>{text.slice(-2)}</span>
      </span>
    )
  }
}

const SquirrelGraphic = () =>
  <svg className='squirrel-graphic' xmlns={svgNs} viewBox='0 2 100 100' width='50' height='50' style={{display: 'block'}}>
    <path d='m 57.743013,29.127309 c -12.93795,0.179207 -22.347307,11.920556 -21.895807,24.86346 0.453995,13.014395 12.723204,19.422555 11.922584,33.151853 -0.252254,4.325777 -2.256285,9.132424 -8.96533,14.164208 17.743524,-2.957243 17.743524,-20.700777 17.743524,-35.487045 0,-18.265493 16.265304,-18.27202 22.707897,-8.660942 C 82.21312,36.458046 68.526468,28.977945 57.743013,29.127309 Z M 15.583664,51.653267 c -0.04923,-0.0018 -0.09976,0.0016 -0.151328,0.0098 -1.436303,0.228226 -1.15389,2.04243 -1.331342,4.755288 a 9.8298778,9.8298778 0 0 0 -2.870038,-0.428571 9.8298778,9.8298778 0 0 0 -9.829403,9.829983 9.8298778,9.8298778 0 0 0 9.829403,9.82998 9.8298778,9.8298778 0 0 0 9.829981,-9.82998 9.8298778,9.8298778 0 0 0 -2.327682,-6.351744 c -1.192858,-3.122049 -1.645077,-7.758565 -3.149591,-7.81477 z M 9.2169048,62.582976 a 1.9162314,1.9162314 0 0 1 1.9164392,1.916439 1.9162314,1.9162314 0 0 1 -1.9164392,1.916439 1.9162314,1.9162314 0 0 1 -1.9164393,-1.916439 1.9162314,1.9162314 0 0 1 1.9164393,-1.916439 z m 21.3494092,6.616278 a 16.264895,16.264895 0 0 0 -16.264896,16.264897 16.264895,16.264895 0 0 0 9.497867,14.789739 1.4114845,1.4114845 0 0 0 -0.01155,0.18136 1.4114845,1.4114845 0 0 0 1.41105,1.41162 1.4114845,1.4114845 0 0 0 1.196185,-0.66191 16.264895,16.264895 0 0 0 4.171345,0.54409 A 16.264895,16.264895 0 0 0 46.831211,85.464151 16.264895,16.264895 0 0 0 30.566314,69.199254 Z M 5.3164492,76.690579 A 3.9153737,3.9153737 0 0 0 1.401553,80.606053 3.9153737,3.9153737 0 0 0 5.3164492,84.521526 3.9153737,3.9153737 0 0 0 9.231922,80.606053 3.9153737,3.9153737 0 0 0 5.3164492,76.690579 Z' />
  </svg>

function PlusSvg() {
  const r = 15; // Radius
  const m = 2; // Margin
  const w = r * 2 + m * 2; // Width
  const s = r / 2; // Size of plus

  return (
    <svg
      className='plus-svg'
      xmlns={svgNs}
      viewBox={`${-r - m} ${-r - m} ${w} ${w}`}
      width={w}
      height={w}
      style={{ display: 'block' }}
    >
      <circle r={r} />
      <path d={`M ${-s} 0 L ${s} 0 M 0 ${-s} L 0 ${s}`}/>
    </svg>
  )
}

const MobileTopMenuBar = oldRenderPatternToReact(renderMobileTopMenuBar, ref => <svg ref={ref}/>);
const ListMenuComponent = oldRenderPatternToReact(renderListMenu, ref => <svg ref={ref}/>);
