/**
 * Copyright 2019 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { assert } from './assert.js';
import { helper } from './helper.js';
import {
  LifecycleWatcher,
  PuppeteerLifeCycleEvent,
} from './LifecycleWatcher.js';
import { TimeoutError } from './Errors.js';
import { JSHandle, ElementHandle } from './JSHandle.js';
import { ExecutionContext } from './ExecutionContext.js';
import { TimeoutSettings } from './TimeoutSettings.js';
import { MouseButton } from './Input.js';
import { FrameManager, Frame } from './FrameManager.js';
import { getQueryHandlerAndSelector } from './QueryHandler.js';
import {
  SerializableOrJSHandle,
  EvaluateHandleFn,
  WrapElementHandle,
  EvaluateFn,
  EvaluateFnReturnType,
  UnwrapPromiseLike,
} from './EvalTypes.js';
import { isNode } from '../environment.js';

// predicateQueryHandler and checkWaitForOptions are declared here so that
// TypeScript knows about them when used in the predicate function below.
declare const predicateQueryHandler: (
  element: Element | Document,
  selector: string
) => Element | Element[] | NodeListOf<Element>;
declare const checkWaitForOptions: (
  node: Node,
  waitForVisible: boolean,
  waitForHidden: boolean
) => Element | null | boolean;

/**
 * @public
 */
export interface WaitForSelectorOptions {
  visible?: boolean;
  hidden?: boolean;
  timeout?: number;
}

/**
 * @internal
 */
export class DOMWorld {
  private _frameManager: FrameManager;
  private _frame: Frame;
  private _timeoutSettings: TimeoutSettings;
  private _documentPromise?: Promise<ElementHandle> = null;
  private _contextPromise?: Promise<ExecutionContext> = null;

  private _contextResolveCallback?: (x?: ExecutionContext) => void = null;

  private _detached = false;
  /**
   * internal
   */
  _waitTasks = new Set<WaitTask>();

  constructor(
    frameManager: FrameManager,
    frame: Frame,
    timeoutSettings: TimeoutSettings
  ) {
    this._frameManager = frameManager;
    this._frame = frame;
    this._timeoutSettings = timeoutSettings;
    this._setContext(null);
  }

  frame(): Frame {
    return this._frame;
  }

  _setContext(context?: ExecutionContext): void {
    if (context) {
      this._contextResolveCallback.call(null, context);
      this._contextResolveCallback = null;
      for (const waitTask of this._waitTasks) waitTask.rerun();
    } else {
      this._documentPromise = null;
      this._contextPromise = new Promise((fulfill) => {
        this._contextResolveCallback = fulfill;
      });
    }
  }

  _hasContext(): boolean {
    return !this._contextResolveCallback;
  }

  _detach(): void {
    this._detached = true;
    for (const waitTask of this._waitTasks)
      waitTask.terminate(
        new Error('waitForFunction failed: frame got detached.')
      );
  }

  executionContext(): Promise<ExecutionContext> {
    if (this._detached)
      throw new Error(
        `Execution Context is not available in detached frame "${this._frame.url()}" (are you trying to evaluate?)`
      );
    return this._contextPromise;
  }

  async evaluateHandle<HandlerType extends JSHandle = JSHandle>(
    pageFunction: EvaluateHandleFn,
    ...args: SerializableOrJSHandle[]
  ): Promise<HandlerType> {
    const context = await this.executionContext();
    return context.evaluateHandle(pageFunction, ...args);
  }

  async evaluate<T extends EvaluateFn>(
    pageFunction: T,
    ...args: SerializableOrJSHandle[]
  ): Promise<UnwrapPromiseLike<EvaluateFnReturnType<T>>> {
    const context = await this.executionContext();
    return context.evaluate<UnwrapPromiseLike<EvaluateFnReturnType<T>>>(
      pageFunction,
      ...args
    );
  }

  async $(selector: string): Promise<ElementHandle | null> {
    const document = await this._document();
    const value = await document.$(selector);
    return value;
  }

  async _document(): Promise<ElementHandle> {
    if (this._documentPromise) return this._documentPromise;
    this._documentPromise = this.executionContext().then(async (context) => {
      const document = await context.evaluateHandle('document');
      return document.asElement();
    });
    return this._documentPromise;
  }

  async $x(expression: string): Promise<ElementHandle[]> {
    const document = await this._document();
    const value = await document.$x(expression);
    return value;
  }

  async $eval<ReturnType>(
    selector: string,
    pageFunction: (
      element: Element,
      ...args: unknown[]
    ) => ReturnType | Promise<ReturnType>,
    ...args: SerializableOrJSHandle[]
  ): Promise<WrapElementHandle<ReturnType>> {
    const document = await this._document();
    return document.$eval<ReturnType>(selector, pageFunction, ...args);
  }

  async $$eval<ReturnType>(
    selector: string,
    pageFunction: (
      elements: Element[],
      ...args: unknown[]
    ) => ReturnType | Promise<ReturnType>,
    ...args: SerializableOrJSHandle[]
  ): Promise<WrapElementHandle<ReturnType>> {
    const document = await this._document();
    const value = await document.$$eval<ReturnType>(
      selector,
      pageFunction,
      ...args
    );
    return value;
  }

  async $$(selector: string): Promise<ElementHandle[]> {
    const document = await this._document();
    const value = await document.$$(selector);
    return value;
  }

  async content(): Promise<string> {
    return await this.evaluate(() => {
      let retVal = '';
      if (document.doctype)
        retVal = new XMLSerializer().serializeToString(document.doctype);
      if (document.documentElement)
        retVal += document.documentElement.outerHTML;
      return retVal;
    });
  }

  async setContent(
    html: string,
    options: {
      timeout?: number;
      waitUntil?: PuppeteerLifeCycleEvent | PuppeteerLifeCycleEvent[];
    } = {}
  ): Promise<void> {
    const {
      waitUntil = ['load'],
      timeout = this._timeoutSettings.navigationTimeout(),
    } = options;
    // We rely upon the fact that document.open() will reset frame lifecycle with "init"
    // lifecycle event. @see https://crrev.com/608658
    await this.evaluate<(x: string) => void>((html) => {
      document.open();
      document.write(html);
      document.close();
    }, html);
    const watcher = new LifecycleWatcher(
      this._frameManager,
      this._frame,
      waitUntil,
      timeout
    );
    const error = await Promise.race([
      watcher.timeoutOrTerminationPromise(),
      watcher.lifecyclePromise(),
    ]);
    watcher.dispose();
    if (error) throw error;
  }

  /**
   * Adds a script tag into the current context.
   *
   * @remarks
   *
   * You can pass a URL, filepath or string of contents. Note that when running Puppeteer
   * in a browser environment you cannot pass a filepath and should use either
   * `url` or `content`.
   */
  async addScriptTag(options: {
    url?: string;
    path?: string;
    content?: string;
    type?: string;
  }): Promise<ElementHandle> {
    const { url = null, path = null, content = null, type = '' } = options;
    if (url !== null) {
      try {
        const context = await this.executionContext();
        return (
          await context.evaluateHandle(addScriptUrl, url, type)
        ).asElement();
      } catch (error) {
        throw new Error(`Loading script from ${url} failed`);
      }
    }

    if (path !== null) {
      if (!isNode) {
        throw new Error(
          'Cannot pass a filepath to addScriptTag in the browser environment.'
        );
      }
      const fs = await import('fs');
      let contents = await fs.promises.readFile(path, 'utf8');
      contents += '//# sourceURL=' + path.replace(/\n/g, '');
      const context = await this.executionContext();
      return (
        await context.evaluateHandle(addScriptContent, contents, type)
      ).asElement();
    }

    if (content !== null) {
      const context = await this.executionContext();
      return (
        await context.evaluateHandle(addScriptContent, content, type)
      ).asElement();
    }

    throw new Error(
      'Provide an object with a `url`, `path` or `content` property'
    );

    async function addScriptUrl(
      url: string,
      type: string
    ): Promise<HTMLElement> {
      const script = document.createElement('script');
      script.src = url;
      if (type) script.type = type;
      const promise = new Promise((res, rej) => {
        script.onload = res;
        script.onerror = rej;
      });
      document.head.appendChild(script);
      await promise;
      return script;
    }

    function addScriptContent(
      content: string,
      type = 'text/javascript'
    ): HTMLElement {
      const script = document.createElement('script');
      script.type = type;
      script.text = content;
      let error = null;
      script.onerror = (e) => (error = e);
      document.head.appendChild(script);
      if (error) throw error;
      return script;
    }
  }

  /**
   * Adds a style tag into the current context.
   *
   * @remarks
   *
   * You can pass a URL, filepath or string of contents. Note that when running Puppeteer
   * in a browser environment you cannot pass a filepath and should use either
   * `url` or `content`.
   *
   */
  async addStyleTag(options: {
    url?: string;
    path?: string;
    content?: string;
  }): Promise<ElementHandle> {
    const { url = null, path = null, content = null } = options;
    if (url !== null) {
      try {
        const context = await this.executionContext();
        return (await context.evaluateHandle(addStyleUrl, url)).asElement();
      } catch (error) {
        throw new Error(`Loading style from ${url} failed`);
      }
    }

    if (path !== null) {
      if (!isNode) {
        throw new Error(
          'Cannot pass a filepath to addStyleTag in the browser environment.'
        );
      }
      const fs = await import('fs');
      let contents = await fs.promises.readFile(path, 'utf8');
      contents += '/*# sourceURL=' + path.replace(/\n/g, '') + '*/';
      const context = await this.executionContext();
      return (
        await context.evaluateHandle(addStyleContent, contents)
      ).asElement();
    }

    if (content !== null) {
      const context = await this.executionContext();
      return (
        await context.evaluateHandle(addStyleContent, content)
      ).asElement();
    }

    throw new Error(
      'Provide an object with a `url`, `path` or `content` property'
    );

    async function addStyleUrl(url: string): Promise<HTMLElement> {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      const promise = new Promise((res, rej) => {
        link.onload = res;
        link.onerror = rej;
      });
      document.head.appendChild(link);
      await promise;
      return link;
    }

    async function addStyleContent(content: string): Promise<HTMLElement> {
      const style = document.createElement('style');
      style.type = 'text/css';
      style.appendChild(document.createTextNode(content));
      const promise = new Promise((res, rej) => {
        style.onload = res;
        style.onerror = rej;
      });
      document.head.appendChild(style);
      await promise;
      return style;
    }
  }

  async click(
    selector: string,
    options: { delay?: number; button?: MouseButton; clickCount?: number }
  ): Promise<void> {
    const handle = await this.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.click(options);
    await handle.dispose();
  }

  async focus(selector: string): Promise<void> {
    const handle = await this.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.focus();
    await handle.dispose();
  }

  async hover(selector: string): Promise<void> {
    const handle = await this.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.hover();
    await handle.dispose();
  }

  async select(selector: string, ...values: string[]): Promise<string[]> {
    const handle = await this.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    const result = await handle.select(...values);
    await handle.dispose();
    return result;
  }

  async tap(selector: string): Promise<void> {
    const handle = await this.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.tap();
    await handle.dispose();
  }

  async type(
    selector: string,
    text: string,
    options?: { delay: number }
  ): Promise<void> {
    const handle = await this.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.type(text, options);
    await handle.dispose();
  }

  async waitForSelector(
    selector: string,
    options: WaitForSelectorOptions
  ): Promise<ElementHandle | null> {
    const { updatedSelector, queryHandler } = getQueryHandlerAndSelector(
      selector
    );
    return queryHandler.waitFor(this, updatedSelector, options);
  }

  /**
   * @internal
   */
  async waitForSelectorInPage(
    queryOne: Function,
    selector: string,
    options: WaitForSelectorOptions
  ): Promise<ElementHandle | null> {
    const {
      visible: waitForVisible = false,
      hidden: waitForHidden = false,
      timeout = this._timeoutSettings.timeout(),
    } = options;
    const polling = waitForVisible || waitForHidden ? 'raf' : 'mutation';
    const title = `selector \`${selector}\`${
      waitForHidden ? ' to be hidden' : ''
    }`;
    function predicate(
      selector: string,
      waitForVisible: boolean,
      waitForHidden: boolean
    ): Node | null | boolean {
      const node = predicateQueryHandler
        ? (predicateQueryHandler(document, selector) as Element)
        : document.querySelector(selector);
      return checkWaitForOptions(node, waitForVisible, waitForHidden);
    }
    const waitTask = new WaitTask(
      this,
      this._makePredicateString(predicate, queryOne),
      title,
      polling,
      timeout,
      selector,
      waitForVisible,
      waitForHidden
    );
    const jsHandle = await waitTask.promise;
    const elementHandle = jsHandle.asElement();
    if (!elementHandle) {
      await jsHandle.dispose();
      return null;
    }
    return elementHandle;
  }

  async waitForXPath(
    xpath: string,
    options: WaitForSelectorOptions
  ): Promise<ElementHandle | null> {
    const {
      visible: waitForVisible = false,
      hidden: waitForHidden = false,
      timeout = this._timeoutSettings.timeout(),
    } = options;
    const polling = waitForVisible || waitForHidden ? 'raf' : 'mutation';
    const title = `XPath \`${xpath}\`${waitForHidden ? ' to be hidden' : ''}`;
    function predicate(
      xpath: string,
      waitForVisible: boolean,
      waitForHidden: boolean
    ): Node | null | boolean {
      const node = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue;
      return checkWaitForOptions(node, waitForVisible, waitForHidden);
    }
    const waitTask = new WaitTask(
      this,
      this._makePredicateString(predicate),
      title,
      polling,
      timeout,
      xpath,
      waitForVisible,
      waitForHidden
    );
    const jsHandle = await waitTask.promise;
    const elementHandle = jsHandle.asElement();
    if (!elementHandle) {
      await jsHandle.dispose();
      return null;
    }
    return elementHandle;
  }

  private _makePredicateString(
    predicate: Function,
    predicateQueryHandler?: Function
  ): string {
    const predicateQueryHandlerDef = predicateQueryHandler
      ? `const predicateQueryHandler = ${predicateQueryHandler};`
      : '';
    return `
    (() => {
      ${predicateQueryHandlerDef}
      const checkWaitForOptions = ${checkWaitForOptions};
      return (${predicate})(...args)
    })() `;
    function checkWaitForOptions(
      node: Node,
      waitForVisible: boolean,
      waitForHidden: boolean
    ): Node | null | boolean {
      if (!node) return waitForHidden;
      if (!waitForVisible && !waitForHidden) return node;
      const element =
        node.nodeType === Node.TEXT_NODE
          ? node.parentElement
          : (node as Element);

      const style = window.getComputedStyle(element);
      const isVisible =
        style && style.visibility !== 'hidden' && hasVisibleBoundingBox();
      const success =
        waitForVisible === isVisible || waitForHidden === !isVisible;
      return success ? node : null;

      function hasVisibleBoundingBox(): boolean {
        const rect = element.getBoundingClientRect();
        return !!(rect.top || rect.bottom || rect.width || rect.height);
      }
    }
  }

  waitForFunction(
    pageFunction: Function | string,
    options: { polling?: string | number; timeout?: number } = {},
    ...args: SerializableOrJSHandle[]
  ): Promise<JSHandle> {
    const {
      polling = 'raf',
      timeout = this._timeoutSettings.timeout(),
    } = options;
    return new WaitTask(
      this,
      pageFunction,
      'function',
      polling,
      timeout,
      ...args
    ).promise;
  }

  async title(): Promise<string> {
    return this.evaluate(() => document.title);
  }
}

class WaitTask {
  _domWorld: DOMWorld;
  _polling: string | number;
  _timeout: number;
  _predicateBody: string;
  _args: SerializableOrJSHandle[];
  _runCount = 0;
  promise: Promise<JSHandle>;
  _resolve: (x: JSHandle) => void;
  _reject: (x: Error) => void;
  _timeoutTimer?: NodeJS.Timeout;
  _terminated = false;

  constructor(
    domWorld: DOMWorld,
    predicateBody: Function | string,
    title: string,
    polling: string | number,
    timeout: number,
    ...args: SerializableOrJSHandle[]
  ) {
    if (helper.isString(polling))
      assert(
        polling === 'raf' || polling === 'mutation',
        'Unknown polling option: ' + polling
      );
    else if (helper.isNumber(polling))
      assert(polling > 0, 'Cannot poll with non-positive interval: ' + polling);
    else throw new Error('Unknown polling options: ' + polling);

    function getPredicateBody(predicateBody: Function | string) {
      if (helper.isString(predicateBody)) return `return (${predicateBody});`;
      return `return (${predicateBody})(...args);`;
    }

    this._domWorld = domWorld;
    this._polling = polling;
    this._timeout = timeout;
    this._predicateBody = getPredicateBody(predicateBody);
    this._args = args;
    this._runCount = 0;
    domWorld._waitTasks.add(this);
    this.promise = new Promise<JSHandle>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
    // Since page navigation requires us to re-install the pageScript, we should track
    // timeout on our end.
    if (timeout) {
      const timeoutError = new TimeoutError(
        `waiting for ${title} failed: timeout ${timeout}ms exceeded`
      );
      this._timeoutTimer = setTimeout(
        () => this.terminate(timeoutError),
        timeout
      );
    }
    this.rerun();
  }

  terminate(error: Error): void {
    this._terminated = true;
    this._reject(error);
    this._cleanup();
  }

  async rerun(): Promise<void> {
    const runCount = ++this._runCount;
    /** @type {?JSHandle} */
    let success = null;
    let error = null;
    try {
      success = await (await this._domWorld.executionContext()).evaluateHandle(
        waitForPredicatePageFunction,
        this._predicateBody,
        this._polling,
        this._timeout,
        ...this._args
      );
    } catch (error_) {
      error = error_;
    }

    if (this._terminated || runCount !== this._runCount) {
      if (success) await success.dispose();
      return;
    }

    // Ignore timeouts in pageScript - we track timeouts ourselves.
    // If the frame's execution context has already changed, `frame.evaluate` will
    // throw an error - ignore this predicate run altogether.
    if (
      !error &&
      (await this._domWorld.evaluate((s) => !s, success).catch(() => true))
    ) {
      await success.dispose();
      return;
    }

    // When the page is navigated, the promise is rejected.
    // We will try again in the new execution context.
    if (error && error.message.includes('Execution context was destroyed'))
      return;

    // We could have tried to evaluate in a context which was already
    // destroyed.
    if (
      error &&
      error.message.includes('Cannot find context with specified id')
    )
      return;

    if (error) this._reject(error);
    else this._resolve(success);

    this._cleanup();
  }

  _cleanup(): void {
    clearTimeout(this._timeoutTimer);
    this._domWorld._waitTasks.delete(this);
  }
}

async function waitForPredicatePageFunction(
  predicateBody: string,
  polling: string,
  timeout: number,
  ...args: unknown[]
): Promise<unknown> {
  const predicate = new Function('...args', predicateBody);
  let timedOut = false;
  if (timeout) setTimeout(() => (timedOut = true), timeout);
  if (polling === 'raf') return await pollRaf();
  if (polling === 'mutation') return await pollMutation();
  if (typeof polling === 'number') return await pollInterval(polling);

  /**
   * @returns {!Promise<*>}
   */
  async function pollMutation(): Promise<unknown> {
    const success = await predicate(...args);
    if (success) return Promise.resolve(success);

    let fulfill;
    const result = new Promise((x) => (fulfill = x));
    const observer = new MutationObserver(async () => {
      if (timedOut) {
        observer.disconnect();
        fulfill();
      }
      const success = await predicate(...args);
      if (success) {
        observer.disconnect();
        fulfill(success);
      }
    });
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    return result;
  }

  async function pollRaf(): Promise<unknown> {
    let fulfill;
    const result = new Promise((x) => (fulfill = x));
    await onRaf();
    return result;

    async function onRaf(): Promise<unknown> {
      if (timedOut) {
        fulfill();
        return;
      }
      const success = await predicate(...args);
      if (success) fulfill(success);
      else requestAnimationFrame(onRaf);
    }
  }

  async function pollInterval(pollInterval: number): Promise<unknown> {
    let fulfill;
    const result = new Promise((x) => (fulfill = x));
    await onTimeout();
    return result;

    async function onTimeout(): Promise<unknown> {
      if (timedOut) {
        fulfill();
        return;
      }
      const success = await predicate(...args);
      if (success) fulfill(success);
      else setTimeout(onTimeout, pollInterval);
    }
  }
}
