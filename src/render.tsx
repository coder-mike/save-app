import * as React from 'react';
import * as ReactDOM from 'react-dom';
import 'react-dom';
import { addUserAction, createReadyIndicatorSvg, deserializeDate, getList, Globals, hideMobileNav, navListItemClick, rateInDollarsPerMs, renderCurrency, renderList, renderNavigator, signInClick, signOutClick, signUpClick } from './app';
import { AppMode, Currency, LinearAmount, List, Snapshot, SyncStatus, UserInfo } from './data-model';
import { getAllocatedRate } from './utils';

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

const classes = (...classes: string[]) =>
  classes
    .filter(Boolean)
    .join(' ')

export const Page = (p: PageProps) =>
  <SnapshotTimeContext.Provider value={{ snapshotTime: deserializeDate(p.snapshot.time) }}>
    <div id='page' className={classes(p.syncStatus, p.mode, p.debugMode && 'debug-mode')}>
      <Navigator {...p}/>
      <ListComponent value={p.snapshot.lists[p.currentListIndex]} />
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

const NavigatorItem = ({ list, isActive }: { list: List, isActive: boolean }) => {
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

const ListComponent = ({ list }: { list: List }) =>
  <div id='current-list' className='list'>
    { /* TODO: attach domDataAttachments for events */ }
    <div className='list-sticky-area'>
      <SquirrelGraphic />
      <MobileTopMenuBar />
      <div className="list-header">
        <div className="list-name">
          <ContentEditable
            Component={() => <h1 id='list-heading' className='list-heading' />}
            read={() => getList(list.id).name}
            write={value => addUserAction({ type: 'ListSetName', listId: list.id, newName: value })}
            requiresRender={false}
          />
        </div>
        <div className="list-info">
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
          {(list.kitty.value !== 0 || list.kitty.rate !== 0) &&
            <span className="list-overflow">
                {list.kitty.value >= 0
                  ? <LinearAmountComponent money={list.kitty}/>
                  : <LinearAmountComponent className='debt' money={list.kitty}/>}
              </span>}
        </div>
        <ListMenu />
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
    </div>
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

interface ContentEditableState {
  value: string;
}

class ContentEditable extends React.Component<ContentEditableProps, ContentEditableState> {
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

const LinearAmountComponent = ({ money: { rate, value } }: { money: LinearAmount }) => rate
  ? <StaticMoney value={value}/>
  : <LinearChangingMoney money={{ rate, value }}/>

const StaticMoney = ({ value }: { value: number }) =>
  <span className="money"><span className="main-amount">{formatCurrency(value)}</span></span>

class LinearChangingMoney extends React.Component<{ money: LinearAmount }, { now: number }> {
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

    return <span className="money">
      <span className="main-amount">{text.slice(0, text.length - 2)}</span>
      <span className="sub-cents">{text.slice(-2)}</span>
    </span>
  }
}