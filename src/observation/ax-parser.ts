import type { CdpAxNode, CdpAxProperty, CdpAxPropertyValue, CdpAccessibilityTreeResponse } from './cdp-types';

export interface NormalizedAxNode {
  axNodeId: string;
  backendDOMNodeId?: number;
  role: string;
  name?: string;
  value?: string;
  description?: string;
  disabled?: boolean;
  focused?: boolean;
  checked?: boolean | 'mixed';
  selected?: boolean;
  expanded?: boolean;
  editable?: boolean;
  hidden?: boolean;
  focusable?: boolean;
  documentOrder: number;
}

export function decodeAxPrimitive(value: CdpAxPropertyValue | undefined): string | boolean | number | undefined {
  if (!value || value.value === undefined) {
    return undefined;
  }

  const raw = value.value;
  if (typeof raw === 'string' || typeof raw === 'boolean' || typeof raw === 'number') {
    return raw;
  }

  return undefined;
}

export function decodeAxString(value: CdpAxPropertyValue | undefined): string | undefined {
  const decoded = decodeAxPrimitive(value);
  if (typeof decoded === 'string') {
    const trimmed = decoded.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return undefined;
}

function decodeAxBooleanProperty(properties: CdpAxProperty[] | undefined, name: string): boolean | undefined {
  const property = properties?.find((item) => item.name === name);
  const decoded = decodeAxPrimitive(property?.value);
  return typeof decoded === 'boolean' ? decoded : undefined;
}

function decodeAxChecked(properties: CdpAxProperty[] | undefined): boolean | 'mixed' | undefined {
  const property = properties?.find((item) => item.name === 'checked');
  if (!property?.value) {
    return undefined;
  }

  if (property.value.type === 'tristate') {
    const value = property.value.value;
    if (value === 'mixed') {
      return 'mixed';
    }
    if (value === true || value === 'true') {
      return true;
    }
    if (value === false || value === 'false') {
      return false;
    }
    return undefined;
  }

  const decoded = decodeAxPrimitive(property.value);
  if (decoded === true || decoded === false) {
    return decoded;
  }

  return undefined;
}

export function parseAccessibilityTree(response: CdpAccessibilityTreeResponse): {
  nodes: NormalizedAxNode[];
  axNodeCount: number;
} {
  const nodes = response.nodes ?? [];
  const parsed: NormalizedAxNode[] = [];
  let documentOrder = 0;

  for (const node of nodes) {
    if (node.ignored) {
      continue;
    }

    const axNodeId = node.nodeId?.trim();
    if (!axNodeId) {
      continue;
    }

    const role = decodeAxString(node.role) ?? 'generic';
    parsed.push({
      axNodeId,
      backendDOMNodeId: node.backendDOMNodeId,
      role: role.toLowerCase(),
      name: decodeAxString(node.name),
      value: decodeAxString(node.value),
      description: decodeAxString(node.description),
      disabled: decodeAxBooleanProperty(node.properties, 'disabled'),
      focused: decodeAxBooleanProperty(node.properties, 'focused'),
      checked: decodeAxChecked(node.properties),
      selected: decodeAxBooleanProperty(node.properties, 'selected'),
      expanded: decodeAxBooleanProperty(node.properties, 'expanded'),
      editable: decodeAxBooleanProperty(node.properties, 'editable'),
      hidden: decodeAxBooleanProperty(node.properties, 'hidden'),
      focusable: decodeAxBooleanProperty(node.properties, 'focusable'),
      documentOrder: documentOrder++,
    });
  }

  return {
    nodes: parsed,
    axNodeCount: nodes.length,
  };
}
