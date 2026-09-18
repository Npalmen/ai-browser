import { InteractionError } from '../shared/interaction-errors';
import {
  MAX_INTERACTION_SCROLL_AMOUNT_PX,
  MAX_INTERACTION_TYPE_TEXT_LENGTH,
  type InteractionScrollDirection,
} from '../shared/interaction-types';
import {
  extractLiveBoxRect,
  liveBoxCenter,
  observedBoundsDriftExceeded,
  type LiveBoxRect,
} from '../interaction/box-model';
import { collectFrameTreeInfo, isSupportedInteractionFrame } from '../interaction/frame-support';
import { extractDocumentIdentity } from '../observation/document-identity';
import type { InteractionCdpClient } from '../observation/interaction-cdp-client';
import { deriveNativeSelectKeyboardPlan } from '../interaction/native-select-preflight';
import type {
  AdapterClickRequest,
  AdapterInteractionResult,
  AdapterObservedBounds,
  AdapterScrollIntoViewRequest,
  AdapterSelectRequest,
  AdapterTargetRef,
  AdapterTypeRequest,
  AdapterViewportScrollRequest,
} from './interaction-adapter-types';

const KEY_MODIFIER_CTRL = 2;

export async function executeAdapterClick(
  cdp: InteractionCdpClient,
  request: AdapterClickRequest,
): Promise<AdapterInteractionResult> {
  assertAdapterTarget(request.target);
  await assertDocumentRevision(cdp, request.target.documentRevision);
  await assertSupportedFrame(cdp, request.target.frameId);

  const liveBox = await preflightTargetBox(cdp, request.target, request.observedBounds);
  const center = liveBoxCenter(liveBox);

  request.onBeforeInputDispatch?.();

  await cdp.dispatchMouseEvent({ type: 'mouseMoved', x: center.x, y: center.y });
  await cdp.dispatchMouseEvent({
    type: 'mousePressed',
    x: center.x,
    y: center.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await cdp.dispatchMouseEvent({
    type: 'mouseReleased',
    x: center.x,
    y: center.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });

  return { primitive: 'click' };
}

export async function executeAdapterType(
  cdp: InteractionCdpClient,
  request: AdapterTypeRequest,
): Promise<AdapterInteractionResult> {
  assertAdapterTarget(request.target);
  assertTypeText(request.text);
  await assertDocumentRevision(cdp, request.target.documentRevision);
  await assertSupportedFrame(cdp, request.target.frameId);

  const liveBox = await preflightTargetBox(cdp, request.target, request.observedBounds);
  const center = liveBoxCenter(liveBox);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await cdp.dispatchMouseEvent({ type: 'mouseMoved', x: center.x, y: center.y });
    await cdp.dispatchMouseEvent({
      type: 'mousePressed',
      x: center.x,
      y: center.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await cdp.dispatchMouseEvent({
      type: 'mouseReleased',
      x: center.x,
      y: center.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  }

  await cdp.dispatchKeyEvent({
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: KEY_MODIFIER_CTRL,
  });
  await cdp.dispatchKeyEvent({
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: KEY_MODIFIER_CTRL,
  });
  await cdp.dispatchKeyEvent({
    type: 'keyDown',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
  await cdp.dispatchKeyEvent({
    type: 'keyUp',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });

  await cdp.insertText(request.text);

  return { primitive: 'type' };
}

export async function executeAdapterSelect(
  cdp: InteractionCdpClient,
  request: AdapterSelectRequest,
): Promise<AdapterInteractionResult> {
  assertAdapterTarget(request.selectTarget);
  assertAdapterTarget(request.optionTarget);
  assertSelectTargetPair(request);

  const frameTree = await cdp.getFrameTree();
  const identity = extractDocumentIdentity(frameTree);
  if (identity.revision !== request.selectTarget.documentRevision) {
    throw new InteractionError('PAGE_CHANGED', 'Document revision changed before interaction.');
  }

  await assertSupportedFrame(cdp, request.selectTarget.frameId);
  await assertSupportedFrame(cdp, request.optionTarget.frameId);

  const [accessibilityTree, domSnapshot] = await Promise.all([
    cdp.getAccessibilityTree(),
    cdp.captureDomSnapshot(),
  ]);
  const plan = deriveNativeSelectKeyboardPlan({
    selectBackendNodeId: request.selectTarget.backendNodeId,
    optionBackendNodeId: request.optionTarget.backendNodeId,
    expectedFrameId: request.selectTarget.frameId,
    mainFrameId: identity.mainFrameId,
    accessibilityTree,
    domSnapshot,
  });

  const selectBox = await preflightTargetBox(
    cdp,
    request.selectTarget,
    request.selectObservedBounds,
  );
  const selectCenter = liveBoxCenter(selectBox);

  await cdp.dispatchMouseEvent({ type: 'mouseMoved', x: selectCenter.x, y: selectCenter.y });
  await cdp.dispatchMouseEvent({
    type: 'mousePressed',
    x: selectCenter.x,
    y: selectCenter.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await cdp.dispatchMouseEvent({
    type: 'mouseReleased',
    x: selectCenter.x,
    y: selectCenter.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });

  const steps = Math.abs(plan.keyboardDelta);
  for (let step = 0; step < steps; step += 1) {
    if (plan.keyboardDelta > 0) {
      await dispatchArrowDown(cdp);
    } else if (plan.keyboardDelta < 0) {
      await dispatchArrowUp(cdp);
    }
  }
  await dispatchEnter(cdp);

  return { primitive: 'select' };
}

async function dispatchArrowUp(cdp: InteractionCdpClient): Promise<void> {
  await cdp.dispatchKeyEvent({
    type: 'keyDown',
    key: 'ArrowUp',
    code: 'ArrowUp',
    windowsVirtualKeyCode: 38,
    nativeVirtualKeyCode: 38,
  });
  await cdp.dispatchKeyEvent({
    type: 'keyUp',
    key: 'ArrowUp',
    code: 'ArrowUp',
    windowsVirtualKeyCode: 38,
    nativeVirtualKeyCode: 38,
  });
}

async function dispatchArrowDown(cdp: InteractionCdpClient): Promise<void> {
  await cdp.dispatchKeyEvent({
    type: 'keyDown',
    key: 'ArrowDown',
    code: 'ArrowDown',
    windowsVirtualKeyCode: 40,
    nativeVirtualKeyCode: 40,
  });
  await cdp.dispatchKeyEvent({
    type: 'keyUp',
    key: 'ArrowDown',
    code: 'ArrowDown',
    windowsVirtualKeyCode: 40,
    nativeVirtualKeyCode: 40,
  });
}

async function dispatchEnter(cdp: InteractionCdpClient): Promise<void> {
  await cdp.dispatchKeyEvent({
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await cdp.dispatchKeyEvent({
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

export async function executeAdapterViewportScroll(
  cdp: InteractionCdpClient,
  request: AdapterViewportScrollRequest,
): Promise<AdapterInteractionResult> {
  assertViewportScrollRequest(request);
  await assertDocumentRevision(cdp, request.documentRevision);

  const { deltaX, deltaY } = scrollWheelDelta(request.direction, request.amountPx);
  await cdp.dispatchMouseEvent({
    type: 'mouseWheel',
    x: 1,
    y: 1,
    deltaX,
    deltaY,
  });

  return { primitive: 'scroll' };
}

export async function executeAdapterScrollIntoView(
  cdp: InteractionCdpClient,
  request: AdapterScrollIntoViewRequest,
): Promise<AdapterInteractionResult> {
  assertAdapterTarget(request.target);
  assertScrollIntoViewViewport(request.viewport);
  await assertDocumentRevision(cdp, request.target.documentRevision);
  await assertSupportedFrame(cdp, request.target.frameId);

  const liveBox = await preflightTargetBox(cdp, request.target, request.observedBounds);
  const delta = computeScrollIntoViewDelta(liveBox, request.viewport);

  if (delta.deltaX !== 0 || delta.deltaY !== 0) {
    await cdp.dispatchMouseEvent({
      type: 'mouseWheel',
      x: 1,
      y: 1,
      deltaX: delta.deltaX,
      deltaY: delta.deltaY,
    });
  }

  return { primitive: 'scroll' };
}

export function assertViewportScrollRequest(request: AdapterViewportScrollRequest): void {
  if (!Number.isInteger(request.amountPx) || request.amountPx <= 0) {
    throw new InteractionError('INVALID_INTERACTION_PROPOSAL', 'Scroll amount must be a positive integer.');
  }

  if (request.amountPx > MAX_INTERACTION_SCROLL_AMOUNT_PX) {
    throw new InteractionError(
      'INVALID_INTERACTION_PROPOSAL',
      `Scroll amount exceeds ${MAX_INTERACTION_SCROLL_AMOUNT_PX}.`,
    );
  }

  const viewportLimit =
    request.direction === 'left' || request.direction === 'right'
      ? request.viewportWidth
      : request.viewportHeight;

  if (!Number.isFinite(viewportLimit) || viewportLimit <= 0) {
    throw new InteractionError('INTERACTION_FAILED', 'Viewport dimensions are invalid for scroll.');
  }

  if (request.amountPx > viewportLimit) {
    throw new InteractionError(
      'INVALID_INTERACTION_PROPOSAL',
      'Scroll amount exceeds the current viewport dimension.',
    );
  }
}

function assertAdapterTarget(target: AdapterTargetRef): void {
  if (!Number.isInteger(target.backendNodeId) || target.backendNodeId <= 0) {
    throw new InteractionError('INTERACTION_FAILED', 'Target backendNodeId is invalid.');
  }
}

function assertSelectTargetPair(request: AdapterSelectRequest): void {
  const { selectTarget, optionTarget } = request;

  if (selectTarget.tabId !== optionTarget.tabId) {
    throw new InteractionError('TARGET_STALE', 'Select and option targets must belong to the same tab.');
  }

  if (selectTarget.documentRevision !== optionTarget.documentRevision) {
    throw new InteractionError('TARGET_STALE', 'Select and option targets must share the same document revision.');
  }

  if (selectTarget.frameId !== optionTarget.frameId) {
    throw new InteractionError('UNSUPPORTED_FRAME', 'Select and option targets must share the same frame.');
  }
}

export function assertScrollIntoViewViewport(
  viewport: AdapterScrollIntoViewRequest['viewport'],
): void {
  if (!Number.isFinite(viewport.width) || viewport.width <= 0) {
    throw new InteractionError('INTERACTION_FAILED', 'Viewport width is invalid for scroll into view.');
  }

  if (!Number.isFinite(viewport.height) || viewport.height <= 0) {
    throw new InteractionError('INTERACTION_FAILED', 'Viewport height is invalid for scroll into view.');
  }

  if (!Number.isFinite(viewport.scrollX)) {
    throw new InteractionError('INTERACTION_FAILED', 'Viewport scrollX is invalid for scroll into view.');
  }

  if (!Number.isFinite(viewport.scrollY)) {
    throw new InteractionError('INTERACTION_FAILED', 'Viewport scrollY is invalid for scroll into view.');
  }
}

function assertTypeText(text: string): void {
  if (text.length === 0 || text.length > MAX_INTERACTION_TYPE_TEXT_LENGTH) {
    throw new InteractionError('INVALID_INTERACTION_PROPOSAL', 'Type text is empty or exceeds the maximum length.');
  }
}

async function assertDocumentRevision(
  cdp: InteractionCdpClient,
  expectedRevision: string,
): Promise<void> {
  const frameTree = await cdp.getFrameTree();
  const liveRevision = extractDocumentIdentity(frameTree).revision;

  if (liveRevision !== expectedRevision) {
    throw new InteractionError('PAGE_CHANGED', 'Document revision changed before interaction.');
  }
}

async function assertSupportedFrame(cdp: InteractionCdpClient, frameId: string): Promise<void> {
  const frameTree = await cdp.getFrameTree();
  const frameInfo = collectFrameTreeInfo(frameTree);

  if (!isSupportedInteractionFrame(frameId, frameInfo)) {
    throw new InteractionError('UNSUPPORTED_FRAME', `Frame ${frameId} is not supported for interaction.`);
  }
}

async function preflightTargetBox(
  cdp: InteractionCdpClient,
  target: AdapterTargetRef,
  observedBounds?: AdapterObservedBounds,
): Promise<LiveBoxRect> {
  try {
    const response = await cdp.getBoxModel(target.backendNodeId);
    const liveBox = extractLiveBoxRect(response.model);
    if (!liveBox) {
      throw new InteractionError('TARGET_NOT_FOUND', 'Target box model is unavailable.');
    }

    if (observedBounds) {
      const observed: LiveBoxRect = {
        x: observedBounds.x,
        y: observedBounds.y,
        width: observedBounds.width,
        height: observedBounds.height,
      };

      if (observedBoundsDriftExceeded(observed, liveBox)) {
        throw new InteractionError('TARGET_STALE', 'Target geometry drifted beyond tolerance.');
      }
    }

    return liveBox;
  } catch (error: unknown) {
    if (error instanceof InteractionError) {
      if (error.code === 'INTERACTION_FAILED') {
        throw new InteractionError('UNSUPPORTED_FRAME', 'Target could not be resolved in the attached session.', {
          cause: error,
        });
      }
      throw error;
    }

    throw new InteractionError('TARGET_NOT_FOUND', 'Target preflight failed.', { cause: error });
  }
}

function scrollWheelDelta(
  direction: InteractionScrollDirection,
  amountPx: number,
): { deltaX: number; deltaY: number } {
  switch (direction) {
    case 'up':
      return { deltaX: 0, deltaY: -amountPx };
    case 'down':
      return { deltaX: 0, deltaY: amountPx };
    case 'left':
      return { deltaX: -amountPx, deltaY: 0 };
    case 'right':
      return { deltaX: amountPx, deltaY: 0 };
  }
}

function computeScrollIntoViewDelta(
  targetBox: LiveBoxRect,
  viewport: AdapterScrollIntoViewRequest['viewport'],
): { deltaX: number; deltaY: number } {
  const margin = 8;
  let deltaX = 0;
  let deltaY = 0;

  const viewportLeft = viewport.scrollX;
  const viewportTop = viewport.scrollY;
  const viewportRight = viewport.scrollX + viewport.width;
  const viewportBottom = viewport.scrollY + viewport.height;

  if (targetBox.x < viewportLeft + margin) {
    deltaX = targetBox.x - (viewportLeft + margin);
  } else if (targetBox.x + targetBox.width > viewportRight - margin) {
    deltaX = targetBox.x + targetBox.width - (viewportRight - margin);
  }

  if (targetBox.y < viewportTop + margin) {
    deltaY = targetBox.y - (viewportTop + margin);
  } else if (targetBox.y + targetBox.height > viewportBottom - margin) {
    deltaY = targetBox.y + targetBox.height - (viewportBottom - margin);
  }

  deltaX = clampScrollDelta(deltaX, viewport.width);
  deltaY = clampScrollDelta(deltaY, viewport.height);

  return { deltaX, deltaY };
}

function clampScrollDelta(delta: number, viewportDimension: number): number {
  if (delta === 0) {
    return 0;
  }

  const max = Math.min(MAX_INTERACTION_SCROLL_AMOUNT_PX, viewportDimension);
  if (Math.abs(delta) > max) {
    return delta > 0 ? max : -max;
  }

  return delta;
}
