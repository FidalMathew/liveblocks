import type { ApplyResult } from "./AbstractCrdt";
import { OpSource } from "./AbstractCrdt";
import { nn } from "./assert";
import type { RoomAuthToken } from "./AuthToken";
import { isTokenExpired, parseRoomAuthToken } from "./AuthToken";
import type { EventSource } from "./EventSource";
import { makeEventSource } from "./EventSource";
import { LiveObject } from "./LiveObject";
import type {
  Authentication,
  AuthorizeResponse,
  BaseUserMeta,
  BroadcastedEventServerMsg,
  BroadcastOptions,
  ClientMsg,
  Connection,
  ConnectionCallback,
  ConnectionState,
  ErrorCallback,
  EventCallback,
  HistoryCallback,
  IdTuple,
  InitialDocumentStateServerMsg,
  Json,
  JsonObject,
  LiveNode,
  LiveStructure,
  LsonObject,
  MyPresenceCallback,
  NodeMap,
  Op,
  Others,
  OthersEvent,
  OthersEventCallback,
  ParentToChildNodeMap,
  Polyfills,
  Room,
  RoomEventCallback,
  RoomEventCallbackFor,
  RoomEventName,
  RoomInitializers,
  RoomStateServerMsg,
  SerializedChild,
  SerializedCrdt,
  SerializedRootObject,
  ServerMsg,
  StorageCallback,
  StorageUpdate,
  UpdatePresenceServerMsg,
  User,
  UserJoinServerMsg,
  UserLeftServerMsg,
} from "./types";
import {
  ClientMsgCode,
  isRoomEventName,
  OpCode,
  ServerMsgCode,
  WebsocketCloseCodes,
} from "./types";
import type { DocumentVisibilityState } from "./types/_compat";
import { isJsonArray, isJsonObject } from "./types/Json";
import { isRootCrdt } from "./types/SerializedCrdt";
import {
  compact,
  getTreesDiffOperations,
  isLiveList,
  isLiveNode,
  isPlainObject,
  isSameNodeOrChildOf,
  mergeStorageUpdates,
  remove,
  tryParseJson,
} from "./utils";

export type Machine<
  TPresence extends JsonObject,
  TStorage extends LsonObject,
  TUserMeta extends BaseUserMeta,
  TRoomEvent extends Json
> = {
  // Internal
  onClose(event: { code: number; wasClean: boolean; reason: string }): void;
  onMessage(event: MessageEvent<string>): void;
  authenticationSuccess(token: RoomAuthToken, socket: WebSocket): void;
  heartbeat(): void;
  onNavigatorOnline(): void;

  // Internal dev tools
  simulateSocketClose(): void;
  simulateSendCloseEvent(event: {
    code: number;
    wasClean: boolean;
    reason: string;
  }): void;

  // onWakeUp,
  onVisibilityChange(visibilityState: DocumentVisibilityState): void;
  getUndoStack(): HistoryItem<TPresence>[];
  getItemsCount(): number;

  // Core
  connect(): null | undefined;
  disconnect(): void;

  // Generic storage callbacks
  subscribe(callback: StorageCallback): () => void;

  // Storage callbacks filtered by Live structure
  subscribe<L extends LiveStructure>(liveStructure: L, callback: (node: L) => void): () => void; // prettier-ignore
  subscribe(node: LiveStructure, callback: StorageCallback, options: { isDeep: true }): () => void; // prettier-ignore

  // Room event callbacks
  subscribe<E extends RoomEventName>(type: E, listener: RoomEventCallbackFor<E, TPresence, TUserMeta, TRoomEvent>): () => void; // prettier-ignore

  // Presence
  updatePresence(
    overrides: Partial<TPresence>,
    options?: { addToHistory: boolean }
  ): void;
  broadcastEvent(event: TRoomEvent, options?: BroadcastOptions): void;

  batch(callback: () => void): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  pauseHistory(): void;
  resumeHistory(): void;

  getStorage(): Promise<{
    root: LiveObject<TStorage>;
  }>;
  getStorageSnapshot(): LiveObject<TStorage> | null;
  events: {
    storageHasLoaded: EventSource<void>;
  };

  selectors: {
    // Core
    getConnectionState(): ConnectionState;
    getSelf(): User<TPresence, TUserMeta> | null;

    // Presence
    getPresence(): TPresence;
    getOthers(): Others<TPresence, TUserMeta>;
  };
};

const BACKOFF_RETRY_DELAYS = [250, 500, 1000, 2000, 4000, 8000, 10000];
const BACKOFF_RETRY_DELAYS_SLOW = [2000, 30000, 60000, 300000];

const HEARTBEAT_INTERVAL = 30000;
// const WAKE_UP_CHECK_INTERVAL = 2000;
const PONG_TIMEOUT = 2000;

function makeIdFactory(connectionId: number): IdFactory {
  let count = 0;
  return () => `${connectionId}:${count++}`;
}

function makeOthers<
  TPresence extends JsonObject,
  TUserMeta extends BaseUserMeta
>(userMap: {
  [key: number]: User<TPresence, TUserMeta>;
}): Others<TPresence, TUserMeta> {
  const users = Object.values(userMap).map((user) => {
    const { _hasReceivedInitialPresence, ...publicKeys } = user;
    return publicKeys;
  });

  return {
    get count() {
      return users.length;
    },
    [Symbol.iterator]() {
      return users[Symbol.iterator]();
    },
    map(callback) {
      return users.map(callback);
    },
    toArray() {
      return users;
    },
  };
}

function log(..._params: unknown[]) {
  // console.log(...params, new Date().toString());
  return;
}

type HistoryItem<TPresence extends JsonObject> = Array<
  | Op
  | {
      type: "presence";
      data: TPresence;
    }
>;

type IdFactory = () => string;

export type State<
  TPresence extends JsonObject,
  TStorage extends LsonObject,
  TUserMeta extends BaseUserMeta,
  TRoomEvent extends Json
> = {
  connection: Connection;
  token: string | null;
  lastConnectionId: number | null;
  socket: WebSocket | null;
  lastFlushTime: number;
  buffer: {
    // Queued-up Presence updates to be flushed at the earliest convenience
    presence:
      | { type: "partial"; data: Partial<TPresence> }
      | { type: "full"; data: TPresence }
      | null;
    messages: ClientMsg<TPresence, TRoomEvent>[];
    storageOperations: Op[];
  };
  timeoutHandles: {
    flush: number | null;
    reconnect: number;
    pongTimeout: number;
  };
  intervalHandles: {
    heartbeat: number;
  };
  listeners: {
    event: EventCallback<TRoomEvent>[];
    others: OthersEventCallback<TPresence, TUserMeta>[];
    "my-presence": MyPresenceCallback<TPresence>[];
    error: ErrorCallback[];
    connection: ConnectionCallback[];
    storage: StorageCallback[];
    history: HistoryCallback[];
  };
  me: TPresence;
  others: Others<TPresence, TUserMeta>;
  users: {
    [connectionId: number]: User<TPresence, TUserMeta>;
  };
  idFactory: IdFactory | null;
  numberOfRetry: number;
  defaultStorageRoot?: TStorage;

  clock: number;
  opClock: number;
  items: Map<string, LiveNode>;
  root: LiveObject<TStorage> | undefined;
  undoStack: HistoryItem<TPresence>[];
  redoStack: HistoryItem<TPresence>[];

  isHistoryPaused: boolean;
  pausedHistory: HistoryItem<TPresence>;

  isBatching: boolean;
  batch: {
    ops: Op[];
    reverseOps: HistoryItem<TPresence>;
    updates: {
      others: [];
      presence: boolean;
      storageUpdates: Map<string, StorageUpdate>;
    };
  };
  offlineOperations: Map<string, Op>;
};

export type Effects<TPresence extends JsonObject, TRoomEvent extends Json> = {
  authenticate(
    auth: (room: string) => Promise<AuthorizeResponse>,
    createWebSocket: (token: string) => WebSocket
  ): void;
  send(messages: ClientMsg<TPresence, TRoomEvent>[]): void;
  delayFlush(delay: number): number;
  startHeartbeatInterval(): number;
  schedulePongTimeout(): number;
  scheduleReconnect(delay: number): number;
};

type Context = {
  roomId: string;
  throttleDelay: number;
  authentication: Authentication;
  liveblocksServer: string;

  polyfills?: Polyfills;

  /**
   * Backward-compatible way to set `polyfills.fetch`.
   */
  fetchPolyfill?: Polyfills["fetch"];

  /**
   * Backward-compatible way to set `polyfills.WebSocket`.
   */
  WebSocketPolyfill?: Polyfills["WebSocket"];
};

export function makeStateMachine<
  TPresence extends JsonObject,
  TStorage extends LsonObject,
  TUserMeta extends BaseUserMeta,
  TRoomEvent extends Json
>(
  state: State<TPresence, TStorage, TUserMeta, TRoomEvent>,
  context: Context,
  mockedEffects?: Effects<TPresence, TRoomEvent>
): Machine<TPresence, TStorage, TUserMeta, TRoomEvent> {
  const effects: Effects<TPresence, TRoomEvent> = mockedEffects || {
    authenticate(
      auth: (room: string) => Promise<AuthorizeResponse>,
      createWebSocket: (token: string) => WebSocket
    ) {
      const rawToken = state.token;
      const parsedToken = rawToken !== null && parseRoomAuthToken(rawToken);
      if (parsedToken && !isTokenExpired(parsedToken)) {
        const socket = createWebSocket(rawToken);
        authenticationSuccess(parsedToken, socket);
      } else {
        return auth(context.roomId)
          .then(({ token }) => {
            if (state.connection.state !== "authenticating") {
              return;
            }
            const parsedToken = parseRoomAuthToken(token);
            const socket = createWebSocket(token);
            authenticationSuccess(parsedToken, socket);
            state.token = token;
          })
          .catch((er: unknown) =>
            authenticationFailure(
              er instanceof Error ? er : new Error(String(er))
            )
          );
      }
    },
    send(
      messageOrMessages:
        | ClientMsg<TPresence, TRoomEvent>
        | ClientMsg<TPresence, TRoomEvent>[]
    ) {
      if (state.socket == null) {
        throw new Error("Can't send message if socket is null");
      }
      state.socket.send(JSON.stringify(messageOrMessages));
    },
    delayFlush(delay: number) {
      return setTimeout(tryFlushing, delay) as any;
    },
    startHeartbeatInterval() {
      return setInterval(heartbeat, HEARTBEAT_INTERVAL) as any;
    },
    schedulePongTimeout() {
      return setTimeout(pongTimeout, PONG_TIMEOUT) as any;
    },
    scheduleReconnect(delay: number) {
      return setTimeout(connect, delay) as any;
    },
  };

  function genericSubscribe(callback: StorageCallback) {
    state.listeners.storage.push(callback);
    return () => remove(state.listeners.storage, callback);
  }

  function subscribeToLiveStructureDeeply<L extends LiveStructure>(
    node: L,
    callback: (updates: StorageUpdate[]) => void
  ): () => void {
    return genericSubscribe((updates) => {
      const relatedUpdates = updates.filter((update) =>
        isSameNodeOrChildOf(update.node, node)
      );
      if (relatedUpdates.length > 0) {
        callback(relatedUpdates);
      }
    });
  }

  function subscribeToLiveStructureShallowly<L extends LiveStructure>(
    node: L,
    callback: (node: L) => void
  ): () => void {
    return genericSubscribe((updates) => {
      for (const update of updates) {
        if (update.node._id === node._id) {
          callback(update.node as L);
        }
      }
    });
  }

  function createOrUpdateRootFromMessage(
    message: InitialDocumentStateServerMsg
  ) {
    if (message.items.length === 0) {
      throw new Error("Internal error: cannot load storage without items");
    }

    if (state.root) {
      updateRoot(message.items);
    } else {
      // TODO: For now, we'll assume the happy path, but reading this data from
      // the central storage server, it may very well turn out to not match the
      // manual type annotation. This will require runtime type validations!
      state.root = load(message.items) as LiveObject<TStorage>;
    }

    for (const key in state.defaultStorageRoot) {
      if (state.root.get(key) == null) {
        state.root.set(key, state.defaultStorageRoot[key]);
      }
    }
  }

  function buildRootAndParentToChildren(
    items: IdTuple<SerializedCrdt>[]
  ): [IdTuple<SerializedRootObject>, ParentToChildNodeMap] {
    const parentToChildren: ParentToChildNodeMap = new Map();
    let root: IdTuple<SerializedRootObject> | null = null;

    for (const [id, crdt] of items) {
      if (isRootCrdt(crdt)) {
        root = [id, crdt];
      } else {
        const tuple: IdTuple<SerializedChild> = [id, crdt];
        const children = parentToChildren.get(crdt.parentId);
        if (children != null) {
          children.push(tuple);
        } else {
          parentToChildren.set(crdt.parentId, [tuple]);
        }
      }
    }

    if (root == null) {
      throw new Error("Root can't be null");
    }

    return [root, parentToChildren];
  }

  function updateRoot(items: IdTuple<SerializedCrdt>[]) {
    if (!state.root) {
      return;
    }

    const currentItems: NodeMap = new Map();
    state.items.forEach((liveCrdt, id) => {
      currentItems.set(id, liveCrdt._toSerializedCrdt());
    });

    // Get operations that represent the diff between 2 states.
    const ops = getTreesDiffOperations(currentItems, new Map(items));

    const result = apply(ops, false);

    notify(result.updates);
  }

  function load(items: IdTuple<SerializedCrdt>[]): LiveObject<LsonObject> {
    const [root, parentToChildren] = buildRootAndParentToChildren(items);

    return LiveObject._deserialize(root, parentToChildren, {
      getItem,
      addItem,
      deleteItem,
      generateId,
      generateOpId,
      dispatch: storageDispatch,
      roomId: context.roomId,
    });
  }

  function addItem(id: string, liveItem: LiveNode) {
    state.items.set(id, liveItem);
  }

  function deleteItem(id: string) {
    state.items.delete(id);
  }

  function getItem(id: string) {
    return state.items.get(id);
  }

  function addToUndoStack(historyItem: HistoryItem<TPresence>) {
    // If undo stack is too large, we remove the older item
    if (state.undoStack.length >= 50) {
      state.undoStack.shift();
    }

    if (state.isHistoryPaused) {
      state.pausedHistory.unshift(...historyItem);
    } else {
      state.undoStack.push(historyItem);
      onHistoryChange();
    }
  }

  function storageDispatch(
    ops: Op[],
    reverse: Op[],
    storageUpdates: Map<string, StorageUpdate>
  ) {
    if (state.isBatching) {
      state.batch.ops.push(...ops);
      storageUpdates.forEach((value, key) => {
        state.batch.updates.storageUpdates.set(
          key,
          mergeStorageUpdates(
            state.batch.updates.storageUpdates.get(key) as any, // FIXME
            value
          )
        );
      });
      state.batch.reverseOps.push(...reverse);
    } else {
      addToUndoStack(reverse);
      state.redoStack = [];
      dispatch(ops);
      notify({ storageUpdates });
    }
  }

  function notify({
    storageUpdates = new Map<string, StorageUpdate>(),
    presence = false,
    others: otherEvents = [],
  }: {
    storageUpdates?: Map<string, StorageUpdate>;
    presence?: boolean;
    others?: OthersEvent<TPresence, TUserMeta>[];
  }) {
    if (otherEvents.length > 0) {
      state.others = makeOthers(state.users);

      for (const event of otherEvents) {
        for (const listener of state.listeners.others) {
          listener(state.others, event);
        }
      }
    }

    if (presence) {
      for (const listener of state.listeners["my-presence"]) {
        listener(state.me);
      }
    }

    if (storageUpdates.size > 0) {
      const updates = Array.from(storageUpdates.values());
      state.listeners.storage.forEach((subscriber) => subscriber(updates));
    }
  }

  function getConnectionId() {
    if (
      state.connection.state === "open" ||
      state.connection.state === "connecting"
    ) {
      return state.connection.id;
    } else if (state.lastConnectionId !== null) {
      return state.lastConnectionId;
    }

    throw new Error(
      "Internal. Tried to get connection id but connection was never open"
    );
  }

  function generateId() {
    return `${getConnectionId()}:${state.clock++}`;
  }

  function generateOpId() {
    return `${getConnectionId()}:${state.opClock++}`;
  }

  function apply(
    item: HistoryItem<TPresence>,
    isLocal: boolean
  ): {
    reverse: HistoryItem<TPresence>;
    updates: {
      storageUpdates: Map<string, StorageUpdate>;
      presence: boolean;
    };
  } {
    const result = {
      reverse: [] as HistoryItem<TPresence>,
      updates: {
        storageUpdates: new Map<string, StorageUpdate>(),
        presence: false,
      },
    };

    const createdNodeIds = new Set<string>();

    for (const op of item) {
      if (op.type === "presence") {
        const reverse = {
          type: "presence" as const,
          data: {} as TPresence,
        };

        for (const key in op.data) {
          reverse.data[key] = state.me[key];
        }

        state.me = { ...state.me, ...op.data };

        if (state.buffer.presence == null) {
          state.buffer.presence = { type: "partial", data: op.data };
        } else {
          // Merge the new fields with whatever is already queued up (doesn't
          // matter whether its a partial or full update)
          for (const key in op.data) {
            state.buffer.presence.data[key] = op.data[key];
          }
        }

        result.reverse.unshift(reverse);
        result.updates.presence = true;
      } else {
        let source: OpSource;

        // Ops applied after undo/redo don't have an opId.
        if (!op.opId) {
          op.opId = generateOpId();
        }

        if (isLocal) {
          source = OpSource.UNDOREDO_RECONNECT;
        } else {
          const deleted = state.offlineOperations.delete(nn(op.opId));
          source = deleted ? OpSource.ACK : OpSource.REMOTE;
        }

        const applyOpResult = applyOp(op, source);
        if (applyOpResult.modified) {
          const parentId =
            applyOpResult.modified.node.parent.type === "HasParent"
              ? nn(
                  applyOpResult.modified.node.parent.node._id,
                  "Expected parent node to have an ID"
                )
              : undefined;

          // If the parent is the root (undefined) or was created in the same batch, we don't want to notify
          // storage updates for the children.
          if (!parentId || !createdNodeIds.has(parentId)) {
            result.updates.storageUpdates.set(
              nn(applyOpResult.modified.node._id),
              mergeStorageUpdates(
                result.updates.storageUpdates.get(
                  nn(applyOpResult.modified.node._id)
                ) as any, // FIXME
                applyOpResult.modified
              )
            );
            result.reverse.unshift(...applyOpResult.reverse);
          }

          if (
            op.type === OpCode.CREATE_LIST ||
            op.type === OpCode.CREATE_MAP ||
            op.type === OpCode.CREATE_OBJECT
          ) {
            createdNodeIds.add(nn(applyOpResult.modified.node._id));
          }
        }
      }
    }
    return result;
  }

  function applyOp(op: Op, source: OpSource): ApplyResult {
    switch (op.type) {
      case OpCode.DELETE_OBJECT_KEY:
      case OpCode.UPDATE_OBJECT:
      case OpCode.DELETE_CRDT: {
        const item = state.items.get(op.id);

        if (item == null) {
          return { modified: false };
        }

        return item._apply(op, source === OpSource.UNDOREDO_RECONNECT);
      }
      case OpCode.SET_PARENT_KEY: {
        const item = state.items.get(op.id);

        if (item == null) {
          return { modified: false };
        }

        if (item.parent.type === "HasParent" && isLiveList(item.parent.node)) {
          return item.parent.node._setChildKey(op.parentKey, item, source);
        }
        return { modified: false };
      }
      case OpCode.CREATE_OBJECT:
      case OpCode.CREATE_LIST:
      case OpCode.CREATE_MAP:
      case OpCode.CREATE_REGISTER: {
        if (op.parentId === undefined) {
          return { modified: false };
        }

        const parent = state.items.get(op.parentId);
        if (parent == null) {
          return { modified: false };
        }

        return parent._attachChild(op, source);
      }
    }
  }

  // Generic storage callbacks
  function subscribe(callback: StorageCallback): () => void; // prettier-ignore
  // Storage callbacks filtered by Live structure
  function subscribe<L extends LiveStructure>(liveStructure: L, callback: (node: L) => void): () => void; // prettier-ignore
  function subscribe(node: LiveStructure, callback: StorageCallback, options: { isDeep: true }): () => void; // prettier-ignore
  // Room event callbacks
  function subscribe<E extends RoomEventName>(type: E, listener: RoomEventCallbackFor<E, TPresence, TUserMeta, TRoomEvent>): () => void; // prettier-ignore

  function subscribe<L extends LiveStructure, E extends RoomEventName>(
    first: StorageCallback | L | E,
    second?: ((node: L) => void) | StorageCallback | RoomEventCallback,
    options?: { isDeep: boolean }
  ): () => void {
    if (second === undefined || typeof first === "function") {
      if (typeof first === "function") {
        const storageCallback = first;
        return genericSubscribe(storageCallback);
      } else {
        throw new Error("Please specify a listener callback");
      }
    }

    if (isLiveNode(first)) {
      const node = first;
      if (options?.isDeep) {
        const storageCallback = second as StorageCallback;
        return subscribeToLiveStructureDeeply(node, storageCallback);
      } else {
        const nodeCallback = second as (node: L) => void;
        return subscribeToLiveStructureShallowly(node, nodeCallback);
      }
    }

    if (!isRoomEventName(first)) {
      throw new Error(`"${first}" is not a valid event name`);
    }

    type EventListener = RoomEventCallbackFor<
      E,
      TPresence,
      TUserMeta,
      TRoomEvent
    >;
    type EventQueue = EventListener[];

    const eventName = first;
    const eventListener = second as EventListener;

    (state.listeners[eventName] as EventQueue).push(eventListener);

    return () => {
      const callbacks = state.listeners[eventName] as EventQueue;
      remove(callbacks, eventListener);
    };
  }

  function getConnectionState() {
    return state.connection.state;
  }

  function getSelf(): User<TPresence, TUserMeta> | null {
    return state.connection.state === "open" ||
      state.connection.state === "connecting"
      ? {
          connectionId: state.connection.id,
          id: state.connection.userId,
          info: state.connection.userInfo,
          presence: getPresence() as TPresence,
        }
      : null;
  }

  function connect() {
    if (
      state.connection.state !== "closed" &&
      state.connection.state !== "unavailable"
    ) {
      return null;
    }

    const auth = prepareAuthEndpoint(
      context.authentication,
      context.polyfills?.fetch ?? context.fetchPolyfill
    );
    const createWebSocket = prepareCreateWebSocket(
      context.liveblocksServer,
      context.polyfills?.WebSocket ?? context.WebSocketPolyfill
    );

    updateConnection({ state: "authenticating" });
    effects.authenticate(auth, createWebSocket);
  }

  function updatePresence(
    overrides: Partial<TPresence>,
    options?: { addToHistory: boolean }
  ) {
    const oldValues = {} as TPresence;

    if (state.buffer.presence == null) {
      state.buffer.presence = {
        type: "partial",
        data: {},
      };
    }

    for (const key in overrides) {
      type K = typeof key;
      const overrideValue: TPresence[K] | undefined = overrides[key];
      if (overrideValue === undefined) {
        continue;
      }
      state.buffer.presence.data[key] = overrideValue;
      oldValues[key] = state.me[key];
    }

    state.me = { ...state.me, ...overrides };

    if (state.isBatching) {
      if (options?.addToHistory) {
        state.batch.reverseOps.push({ type: "presence", data: oldValues });
      }
      state.batch.updates.presence = true;
    } else {
      tryFlushing();
      if (options?.addToHistory) {
        addToUndoStack([{ type: "presence", data: oldValues }]);
      }
      notify({ presence: true });
    }
  }

  function authenticationSuccess(token: RoomAuthToken, socket: WebSocket) {
    socket.addEventListener("message", onMessage);
    socket.addEventListener("open", onOpen);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);

    updateConnection({
      state: "connecting",
      id: token.actor,
      userInfo: token.info,
      userId: token.id,
    });
    state.idFactory = makeIdFactory(token.actor);
    state.socket = socket;
  }

  function authenticationFailure(error: Error) {
    if (process.env.NODE_ENV !== "production") {
      console.error("Call to authentication endpoint failed", error);
    }
    state.token = null;
    updateConnection({ state: "unavailable" });
    state.numberOfRetry++;
    state.timeoutHandles.reconnect = effects.scheduleReconnect(getRetryDelay());
  }

  function onVisibilityChange(visibilityState: DocumentVisibilityState) {
    if (visibilityState === "visible" && state.connection.state === "open") {
      log("Heartbeat after visibility change");
      heartbeat();
    }
  }

  function onUpdatePresenceMessage(
    message: UpdatePresenceServerMsg<TPresence>
  ): OthersEvent<TPresence, TUserMeta> | undefined {
    const user = state.users[message.actor];
    // If the other user initial presence hasn't been received yet, we discard the presence update.
    // The initial presence update message contains the property "targetActor".
    if (
      message.targetActor === undefined &&
      user != null &&
      !user._hasReceivedInitialPresence
    ) {
      return undefined;
    }

    if (user == null) {
      state.users[message.actor] = {
        connectionId: message.actor,
        presence: message.data,
        id: undefined,
        info: undefined,
        _hasReceivedInitialPresence: true,
      };
    } else {
      state.users[message.actor] = {
        id: user.id,
        info: user.info,
        connectionId: message.actor,
        presence: {
          ...user.presence,
          ...message.data,
        },
        _hasReceivedInitialPresence: true,
      };
    }

    return {
      type: "update",
      updates: message.data,
      user: state.users[message.actor],
    };
  }

  function onUserLeftMessage(
    message: UserLeftServerMsg
  ): OthersEvent<TPresence, TUserMeta> | null {
    const userLeftMessage: UserLeftServerMsg = message;
    const user = state.users[userLeftMessage.actor];
    if (user) {
      delete state.users[userLeftMessage.actor];
      return { type: "leave", user };
    }
    return null;
  }

  function onRoomStateMessage(
    message: RoomStateServerMsg<TUserMeta>
  ): OthersEvent<TPresence, TUserMeta> {
    const newUsers: { [connectionId: number]: User<TPresence, TUserMeta> } = {};
    for (const key in message.users) {
      const connectionId = Number.parseInt(key);
      const user = message.users[key];
      newUsers[connectionId] = {
        connectionId,
        info: user.info,
        id: user.id,
      };
    }
    state.users = newUsers;
    return { type: "reset" };
  }

  function onNavigatorOnline() {
    if (state.connection.state === "unavailable") {
      log("Try to reconnect after connectivity change");
      reconnect();
    }
  }

  function onEvent(message: BroadcastedEventServerMsg<TRoomEvent>) {
    for (const listener of state.listeners.event) {
      listener({ connectionId: message.actor, event: message.event });
    }
  }

  function onHistoryChange() {
    for (const listener of state.listeners.history) {
      listener({ canUndo: canUndo(), canRedo: canRedo() });
    }
  }

  function onUserJoinedMessage(
    message: UserJoinServerMsg<TUserMeta>
  ): OthersEvent<TPresence, TUserMeta> {
    state.users[message.actor] = {
      connectionId: message.actor,
      info: message.info,
      id: message.id,
      _hasReceivedInitialPresence: true,
    };

    if (state.me) {
      // Send current presence to new user
      // TODO: Consider storing it on the backend
      state.buffer.messages.push({
        type: ClientMsgCode.UPDATE_PRESENCE,
        data: state.me as TPresence,
        //             ^^^^^^^^^^^^
        //             TODO: Soon, state.buffer.presence will become
        //             a TPresence and this force-cast will no longer be
        //             necessary.
        targetActor: message.actor,
      });
      tryFlushing();
    }

    return { type: "enter", user: state.users[message.actor] };
  }

  function parseServerMessage(
    data: Json
  ): ServerMsg<TPresence, TUserMeta, TRoomEvent> | null {
    if (!isJsonObject(data)) {
      return null;
    }

    return data as ServerMsg<TPresence, TUserMeta, TRoomEvent>;
    //          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ FIXME: Properly validate incoming external data instead!
  }

  function parseServerMessages(
    text: string
  ): ServerMsg<TPresence, TUserMeta, TRoomEvent>[] | null {
    const data: Json | undefined = tryParseJson(text);
    if (data === undefined) {
      return null;
    } else if (isJsonArray(data)) {
      return compact(data.map((item) => parseServerMessage(item)));
    } else {
      return compact([parseServerMessage(data)]);
    }
  }

  function onMessage(event: MessageEvent<string>) {
    if (event.data === "pong") {
      clearTimeout(state.timeoutHandles.pongTimeout);
      return;
    }

    const messages = parseServerMessages(event.data);
    if (messages === null || messages.length === 0) {
      // Unknown incoming message... ignore it
      return;
    }

    const updates = {
      storageUpdates: new Map<string, StorageUpdate>(),
      others: [] as OthersEvent<TPresence, TUserMeta>[],
    };

    for (const message of messages) {
      switch (message.type) {
        case ServerMsgCode.USER_JOINED: {
          updates.others.push(onUserJoinedMessage(message));
          break;
        }
        case ServerMsgCode.UPDATE_PRESENCE: {
          const othersPresenceUpdate = onUpdatePresenceMessage(message);
          if (othersPresenceUpdate) {
            updates.others.push(othersPresenceUpdate);
          }
          break;
        }
        case ServerMsgCode.BROADCASTED_EVENT: {
          onEvent(message);
          break;
        }
        case ServerMsgCode.USER_LEFT: {
          const event = onUserLeftMessage(message);
          if (event) {
            updates.others.push(event);
          }
          break;
        }
        case ServerMsgCode.ROOM_STATE: {
          updates.others.push(onRoomStateMessage(message));
          break;
        }
        case ServerMsgCode.INITIAL_STORAGE_STATE: {
          // createOrUpdateRootFromMessage function could add ops to offlineOperations.
          // Client shouldn't resend these ops as part of the offline ops sending after reconnect.
          const offlineOps = new Map(state.offlineOperations);
          createOrUpdateRootFromMessage(message);
          applyAndSendOfflineOps(offlineOps);
          _getInitialStateResolver?.();
          emitStorageHasLoaded();
          break;
        }
        case ServerMsgCode.UPDATE_STORAGE: {
          const applyResult = apply(message.ops, false);
          applyResult.updates.storageUpdates.forEach((value, key) => {
            updates.storageUpdates.set(
              key,
              mergeStorageUpdates(
                updates.storageUpdates.get(key) as any, // FIXME
                value
              )
            );
          });

          break;
        }
      }
    }

    notify(updates);
  }

  function onClose(event: { code: number; wasClean: boolean; reason: string }) {
    state.socket = null;

    clearTimeout(state.timeoutHandles.pongTimeout);
    clearInterval(state.intervalHandles.heartbeat);
    if (state.timeoutHandles.flush) {
      clearTimeout(state.timeoutHandles.flush);
    }
    clearTimeout(state.timeoutHandles.reconnect);

    state.users = {};
    notify({ others: [{ type: "reset" }] });

    if (event.code >= 4000 && event.code <= 4100) {
      updateConnection({ state: "failed" });

      const error = new LiveblocksError(event.reason, event.code);
      for (const listener of state.listeners.error) {
        listener(error);
      }

      const delay = getRetryDelay(true);
      state.numberOfRetry++;

      if (process.env.NODE_ENV !== "production") {
        console.error(
          `Connection to Liveblocks websocket server closed. Reason: ${error.message} (code: ${error.code}). Retrying in ${delay}ms.`
        );
      }

      updateConnection({ state: "unavailable" });
      state.timeoutHandles.reconnect = effects.scheduleReconnect(delay);
    } else if (event.code === WebsocketCloseCodes.CLOSE_WITHOUT_RETRY) {
      updateConnection({ state: "closed" });
    } else {
      const delay = getRetryDelay();
      state.numberOfRetry++;

      if (process.env.NODE_ENV !== "production") {
        console.warn(
          `Connection to Liveblocks websocket server closed (code: ${event.code}). Retrying in ${delay}ms.`
        );
      }
      updateConnection({ state: "unavailable" });
      state.timeoutHandles.reconnect = effects.scheduleReconnect(delay);
    }
  }

  function updateConnection(connection: Connection) {
    state.connection = connection;
    for (const listener of state.listeners.connection) {
      listener(connection.state);
    }
  }

  function getRetryDelay(slow: boolean = false) {
    if (slow) {
      return BACKOFF_RETRY_DELAYS_SLOW[
        state.numberOfRetry < BACKOFF_RETRY_DELAYS_SLOW.length
          ? state.numberOfRetry
          : BACKOFF_RETRY_DELAYS_SLOW.length - 1
      ];
    }
    return BACKOFF_RETRY_DELAYS[
      state.numberOfRetry < BACKOFF_RETRY_DELAYS.length
        ? state.numberOfRetry
        : BACKOFF_RETRY_DELAYS.length - 1
    ];
  }

  function onError() {}

  function onOpen() {
    clearInterval(state.intervalHandles.heartbeat);

    state.intervalHandles.heartbeat = effects.startHeartbeatInterval();

    if (state.connection.state === "connecting") {
      updateConnection({ ...state.connection, state: "open" });
      state.numberOfRetry = 0;

      // Re-broadcast the user presence during a reconnect.
      if (state.lastConnectionId !== undefined) {
        state.buffer.presence = {
          type: "full",
          data: state.me,
        };
        tryFlushing();
      }

      state.lastConnectionId = state.connection.id;

      if (state.root) {
        state.buffer.messages.push({ type: ClientMsgCode.FETCH_STORAGE });
      }
      tryFlushing();
    } else {
      // TODO
    }
  }

  function heartbeat() {
    if (state.socket == null) {
      // Should never happen, because we clear the pong timeout when the connection is dropped explictly
      return;
    }

    clearTimeout(state.timeoutHandles.pongTimeout);
    state.timeoutHandles.pongTimeout = effects.schedulePongTimeout();

    if (state.socket.readyState === state.socket.OPEN) {
      state.socket.send("ping");
    }
  }

  function pongTimeout() {
    log("Pong timeout. Trying to reconnect.");
    reconnect();
  }

  function reconnect() {
    if (state.socket) {
      state.socket.removeEventListener("open", onOpen);
      state.socket.removeEventListener("message", onMessage);
      state.socket.removeEventListener("close", onClose);
      state.socket.removeEventListener("error", onError);
      state.socket.close();
      state.socket = null;
    }

    updateConnection({ state: "unavailable" });
    clearTimeout(state.timeoutHandles.pongTimeout);
    if (state.timeoutHandles.flush) {
      clearTimeout(state.timeoutHandles.flush);
    }
    clearTimeout(state.timeoutHandles.reconnect);
    clearInterval(state.intervalHandles.heartbeat);
    connect();
  }

  function applyAndSendOfflineOps(offlineOps: Map<string | undefined, Op>) {
    //                                                     ^^^^^^^^^ NOTE: Bug? Unintended?
    if (offlineOps.size === 0) {
      return;
    }

    const messages: ClientMsg<TPresence, TRoomEvent>[] = [];

    const ops = Array.from(offlineOps.values());

    const result = apply(ops, true);

    messages.push({
      type: ClientMsgCode.UPDATE_STORAGE,
      ops,
    });

    notify(result.updates);

    effects.send(messages);
  }

  function tryFlushing() {
    const storageOps = state.buffer.storageOperations;

    if (storageOps.length > 0) {
      storageOps.forEach((op) => {
        state.offlineOperations.set(nn(op.opId), op);
      });
    }

    if (state.socket == null || state.socket.readyState !== state.socket.OPEN) {
      state.buffer.storageOperations = [];
      return;
    }

    const now = Date.now();

    const elapsedTime = now - state.lastFlushTime;

    if (elapsedTime > context.throttleDelay) {
      const messages = flushDataToMessages(state);

      if (messages.length === 0) {
        return;
      }
      effects.send(messages);
      state.buffer = {
        messages: [],
        storageOperations: [],
        presence: null,
      };
      state.lastFlushTime = now;
    } else {
      if (state.timeoutHandles.flush != null) {
        clearTimeout(state.timeoutHandles.flush);
      }

      state.timeoutHandles.flush = effects.delayFlush(
        context.throttleDelay - (now - state.lastFlushTime)
      );
    }
  }

  function flushDataToMessages(
    state: State<TPresence, TStorage, TUserMeta, TRoomEvent>
  ) {
    const messages: ClientMsg<TPresence, TRoomEvent>[] = [];
    if (state.buffer.presence) {
      messages.push(
        state.buffer.presence.type === "full"
          ? {
              type: ClientMsgCode.UPDATE_PRESENCE,
              // Populating the `targetActor` field turns this message into
              // a Full Presence™ update message (not a patch), which will get
              // interpreted by other clients as such.
              targetActor: -1,
              data: state.buffer.presence.data,
            }
          : {
              type: ClientMsgCode.UPDATE_PRESENCE,
              data: state.buffer.presence.data,
            }
      );
    }
    for (const event of state.buffer.messages) {
      messages.push(event);
    }
    if (state.buffer.storageOperations.length > 0) {
      messages.push({
        type: ClientMsgCode.UPDATE_STORAGE,
        ops: state.buffer.storageOperations,
      });
    }
    return messages;
  }

  function disconnect() {
    if (state.socket) {
      state.socket.removeEventListener("open", onOpen);
      state.socket.removeEventListener("message", onMessage);
      state.socket.removeEventListener("close", onClose);
      state.socket.removeEventListener("error", onError);
      state.socket.close();
      state.socket = null;
    }
    updateConnection({ state: "closed" });
    if (state.timeoutHandles.flush) {
      clearTimeout(state.timeoutHandles.flush);
    }
    clearTimeout(state.timeoutHandles.reconnect);
    clearTimeout(state.timeoutHandles.pongTimeout);
    clearInterval(state.intervalHandles.heartbeat);
    state.users = {};
    notify({ others: [{ type: "reset" }] });
    clearListeners();
  }

  function clearListeners() {
    for (const key in state.listeners) {
      state.listeners[
        key as keyof State<
          TPresence,
          TStorage,
          TUserMeta,
          TRoomEvent
        >["listeners"]
      ] = [];
    }
  }

  function getPresence(): TPresence {
    return state.me as TPresence;
  }

  function getOthers(): Others<TPresence, TUserMeta> {
    return state.others as Others<TPresence, TUserMeta>;
  }

  function broadcastEvent(
    event: TRoomEvent,
    options: BroadcastOptions = {
      shouldQueueEventIfNotReady: false,
    }
  ) {
    if (state.socket == null && options.shouldQueueEventIfNotReady == false) {
      return;
    }

    state.buffer.messages.push({
      type: ClientMsgCode.BROADCAST_EVENT,
      event,
    });
    tryFlushing();
  }

  function dispatch(ops: Op[]) {
    state.buffer.storageOperations.push(...ops);
    tryFlushing();
  }

  let _getInitialStatePromise: Promise<void> | null = null;
  let _getInitialStateResolver: (() => void) | null = null;

  function startLoadingStorage(): Promise<void> {
    if (_getInitialStatePromise == null) {
      state.buffer.messages.push({ type: ClientMsgCode.FETCH_STORAGE });
      tryFlushing();
      _getInitialStatePromise = new Promise(
        (resolve) => (_getInitialStateResolver = resolve)
      );
    }
    return _getInitialStatePromise;
  }

  /**
   * Closely related to .getStorage(), but synchronously. Will be `null`
   * initially. When requested for the first time, will kick off the loading of
   * Storage if it hasn't happened yet.
   *
   * Once Storage is loaded, will return a stable reference to the storage
   * root.
   */
  function getStorageSnapshot(): LiveObject<TStorage> | null {
    const root = state.root;
    if (root !== undefined) {
      // Done loading
      return root;
    } else {
      // Not done loading, kick off the loading (will not do anything if already kicked off)
      startLoadingStorage();
      return null;
    }
  }

  const [storageHasLoaded, emitStorageHasLoaded] = makeEventSource<void>();

  function getStorage(): Promise<{
    root: LiveObject<TStorage>;
  }> {
    if (state.root) {
      // Store has already loaded, so we can resolve it directly
      return Promise.resolve({
        root: state.root as LiveObject<TStorage>,
      });
    }

    return startLoadingStorage().then(() => {
      return {
        root: nn(state.root) as LiveObject<TStorage>,
      };
    });
  }

  function undo() {
    if (state.isBatching) {
      throw new Error("undo is not allowed during a batch");
    }
    const historyItem = state.undoStack.pop();

    if (historyItem == null) {
      return;
    }

    state.isHistoryPaused = false;
    const result = apply(historyItem, true);

    notify(result.updates);
    state.redoStack.push(result.reverse);
    onHistoryChange();

    for (const op of historyItem) {
      if (op.type !== "presence") {
        state.buffer.storageOperations.push(op);
      }
    }
    tryFlushing();
  }

  function canUndo() {
    return state.undoStack.length > 0;
  }

  function redo() {
    if (state.isBatching) {
      throw new Error("redo is not allowed during a batch");
    }

    const historyItem = state.redoStack.pop();

    if (historyItem == null) {
      return;
    }

    state.isHistoryPaused = false;
    const result = apply(historyItem, true);
    notify(result.updates);
    state.undoStack.push(result.reverse);
    onHistoryChange();

    for (const op of historyItem) {
      if (op.type !== "presence") {
        state.buffer.storageOperations.push(op);
      }
    }
    tryFlushing();
  }

  function canRedo() {
    return state.redoStack.length > 0;
  }

  function batch(callback: () => void) {
    if (state.isBatching) {
      throw new Error("batch should not be called during a batch");
    }

    state.isBatching = true;

    try {
      callback();
    } finally {
      state.isBatching = false;

      if (state.batch.reverseOps.length > 0) {
        addToUndoStack(state.batch.reverseOps);
      }

      if (state.batch.ops.length > 0) {
        // Only clear the redo stack if something has changed during a batch
        // Clear the redo stack because batch is always called from a local operation
        state.redoStack = [];
      }

      if (state.batch.ops.length > 0) {
        dispatch(state.batch.ops);
      }

      notify(state.batch.updates);
      state.batch = {
        ops: [],
        reverseOps: [],
        updates: {
          others: [],
          storageUpdates: new Map(),
          presence: false,
        },
      };
      tryFlushing();
    }
  }

  function pauseHistory() {
    state.pausedHistory = [];
    state.isHistoryPaused = true;
  }

  function resumeHistory() {
    state.isHistoryPaused = false;
    if (state.pausedHistory.length > 0) {
      addToUndoStack(state.pausedHistory);
    }
    state.pausedHistory = [];
  }

  function simulateSocketClose() {
    if (state.socket) {
      state.socket = null;
    }
  }

  function simulateSendCloseEvent(event: {
    code: number;
    wasClean: boolean;
    reason: string;
  }) {
    onClose(event);
  }

  return {
    // Internal
    onClose,
    onMessage,
    authenticationSuccess,
    heartbeat,
    onNavigatorOnline,
    // Internal dev tools
    simulateSocketClose,
    simulateSendCloseEvent,
    onVisibilityChange,
    getUndoStack: () => state.undoStack,
    getItemsCount: () => state.items.size,

    // Core
    connect,
    disconnect,
    subscribe,

    // Presence
    updatePresence,
    broadcastEvent,

    batch,
    undo,
    redo,
    canUndo,
    canRedo,
    pauseHistory,
    resumeHistory,

    getStorage,
    getStorageSnapshot,
    events: {
      storageHasLoaded,
    },

    selectors: {
      // Core
      getConnectionState,
      getSelf,

      // Presence
      getPresence,
      getOthers,
    },
  };
}

export function defaultState<
  TPresence extends JsonObject,
  TStorage extends LsonObject,
  TUserMeta extends BaseUserMeta,
  TRoomEvent extends Json
>(
  initialPresence?: TPresence,
  initialStorage?: TStorage
): State<TPresence, TStorage, TUserMeta, TRoomEvent> {
  return {
    connection: { state: "closed" },
    token: null,
    lastConnectionId: null,
    socket: null,
    listeners: {
      event: [],
      others: [],
      "my-presence": [],
      error: [],
      connection: [],
      storage: [],
      history: [],
    },
    numberOfRetry: 0,
    lastFlushTime: 0,
    timeoutHandles: {
      flush: null,
      reconnect: 0,
      pongTimeout: 0,
    },
    buffer: {
      presence:
        // Queue up the initial presence message as a Full Presence™ update
        {
          type: "full",
          data: initialPresence == null ? ({} as TPresence) : initialPresence,
        },
      messages: [],
      storageOperations: [],
    },
    intervalHandles: {
      heartbeat: 0,
    },
    me: initialPresence == null ? ({} as TPresence) : initialPresence,
    users: {},
    others: makeOthers({}),
    defaultStorageRoot: initialStorage,
    idFactory: null,

    // Storage
    clock: 0,
    opClock: 0,
    items: new Map<string, LiveNode>(),
    root: undefined,
    undoStack: [],
    redoStack: [],

    isHistoryPaused: false,
    pausedHistory: [],
    isBatching: false,
    batch: {
      ops: [] as Op[],
      updates: {
        storageUpdates: new Map<string, StorageUpdate>(),
        presence: false,
        others: [],
      },
      reverseOps: [] as Op[],
    },
    offlineOperations: new Map<string, Op>(),
  };
}

export type InternalRoom<
  TPresence extends JsonObject,
  TStorage extends LsonObject,
  TUserMeta extends BaseUserMeta,
  TRoomEvent extends Json
> = {
  room: Room<TPresence, TStorage, TUserMeta, TRoomEvent>;
  connect: () => void;
  disconnect: () => void;
  onNavigatorOnline: () => void;
  onVisibilityChange: (visibilityState: DocumentVisibilityState) => void;
};

export function createRoom<
  TPresence extends JsonObject,
  TStorage extends LsonObject,
  TUserMeta extends BaseUserMeta,
  TRoomEvent extends Json
>(
  options: RoomInitializers<TPresence, TStorage>,
  context: Context
): InternalRoom<TPresence, TStorage, TUserMeta, TRoomEvent> {
  const { initialPresence, initialStorage } = options;

  const state = defaultState<TPresence, TStorage, TUserMeta, TRoomEvent>(
    typeof initialPresence === "function"
      ? initialPresence(context.roomId)
      : initialPresence,
    typeof initialStorage === "function"
      ? initialStorage(context.roomId)
      : initialStorage
  );

  const machine = makeStateMachine<TPresence, TStorage, TUserMeta, TRoomEvent>(
    state,
    context
  );

  const room: Room<TPresence, TStorage, TUserMeta, TRoomEvent> = {
    id: context.roomId,
    /////////////
    // Core    //
    /////////////
    getConnectionState: machine.selectors.getConnectionState,
    getSelf: machine.selectors.getSelf,

    subscribe: machine.subscribe,

    //////////////
    // Presence //
    //////////////
    getPresence: machine.selectors.getPresence,
    updatePresence: machine.updatePresence,
    getOthers: machine.selectors.getOthers,
    broadcastEvent: machine.broadcastEvent,

    getStorage: machine.getStorage,
    getStorageSnapshot: machine.getStorageSnapshot,
    events: {
      storageHasLoaded: machine.events.storageHasLoaded,
    },

    batch: machine.batch,
    history: {
      undo: machine.undo,
      redo: machine.redo,
      canUndo: machine.canUndo,
      canRedo: machine.canRedo,
      pause: machine.pauseHistory,
      resume: machine.resumeHistory,
    },

    __INTERNAL_DO_NOT_USE: {
      simulateCloseWebsocket: machine.simulateSocketClose,
      simulateSendCloseEvent: machine.simulateSendCloseEvent,
    },
  };

  return {
    connect: machine.connect,
    disconnect: machine.disconnect,
    onNavigatorOnline: machine.onNavigatorOnline,
    onVisibilityChange: machine.onVisibilityChange,
    room,
  };
}

class LiveblocksError extends Error {
  constructor(message: string, public code: number) {
    super(message);
  }
}

function prepareCreateWebSocket(
  liveblocksServer: string,
  WebSocketPolyfill?: typeof WebSocket
) {
  if (typeof window === "undefined" && WebSocketPolyfill == null) {
    throw new Error(
      "To use Liveblocks client in a non-dom environment, you need to provide a WebSocket polyfill."
    );
  }

  const ws = WebSocketPolyfill || WebSocket;

  return (token: string): WebSocket => {
    return new ws(
      `${liveblocksServer}/?token=${token}&version=${
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore (__PACKAGE_VERSION__ will be injected by the build script)
        typeof __PACKAGE_VERSION__ === "string" ? __PACKAGE_VERSION__ : "dev"
      }`
    );
  };
}

function prepareAuthEndpoint(
  authentication: Authentication,
  fetchPolyfill?: typeof window.fetch
): (room: string) => Promise<AuthorizeResponse> {
  if (authentication.type === "public") {
    if (typeof window === "undefined" && fetchPolyfill == null) {
      throw new Error(
        "To use Liveblocks client in a non-dom environment with a publicApiKey, you need to provide a fetch polyfill."
      );
    }

    return (room: string) =>
      fetchAuthEndpoint(fetchPolyfill || fetch, authentication.url, {
        room,
        publicApiKey: authentication.publicApiKey,
      });
  }

  if (authentication.type === "private") {
    if (typeof window === "undefined" && fetchPolyfill == null) {
      throw new Error(
        "To use Liveblocks client in a non-dom environment with a url as auth endpoint, you need to provide a fetch polyfill."
      );
    }

    return (room: string) =>
      fetchAuthEndpoint(fetchPolyfill || fetch, authentication.url, {
        room,
      });
  }

  if (authentication.type === "custom") {
    const authWithResponseValidation = (room: string) => {
      return authentication.callback(room).then((response) => {
        if (!response || !response.token) {
          throw new Error(
            'Authentication error. We expect the authentication callback to return a token, but it does not. Hint: the return value should look like: { token: "..." }'
          );
        }
        return response;
      });
    };

    return authWithResponseValidation;
  }

  throw new Error("Internal error. Unexpected authentication type");
}

function fetchAuthEndpoint(
  fetch: typeof window.fetch,
  endpoint: string,
  body: {
    room: string;
    publicApiKey?: string;
  }
): Promise<{ token: string }> {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
    .then((res) => {
      if (!res.ok) {
        throw new AuthenticationError(
          `Expected a status 200 but got ${res.status} when doing a POST request on "${endpoint}"`
        );
      }

      return (res.json() as Promise<Json>).catch((er) => {
        throw new AuthenticationError(
          `Expected a JSON response when doing a POST request on "${endpoint}". ${er}`
        );
      });
    })
    .then((data) => {
      if (!isPlainObject(data) || typeof data.token !== "string") {
        throw new AuthenticationError(
          `Expected a JSON response of the form \`{ token: "..." }\` when doing a POST request on "${endpoint}", but got ${JSON.stringify(
            data
          )}`
        );
      }

      const { token } = data;
      return { token };
    });
}

class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
  }
}
