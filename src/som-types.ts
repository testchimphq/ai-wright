/**
 * Set-of-Marks (SoM) Type Definitions
 * Types for visual element identification and interaction
 */

export interface Coordinate {
  x: number;  // When used in coord: percentage of viewport width (0-100). When used in elementRelativeAbsoluteCoords: absolute pixels from element top-left.
  y: number;  // When used in coord: percentage of viewport height (0-100). When used in elementRelativeAbsoluteCoords: absolute pixels from element top-left.
}

export enum InteractionAction {
  // Click actions
  CLICK = 'click',
  DOUBLE_CLICK = 'doubleClick',
  RIGHT_CLICK = 'rightClick',
  
  // Mouse actions
  HOVER = 'hover',
  MOUSE_DOWN = 'mouseDown',
  MOUSE_UP = 'mouseUp',
  DRAG = 'drag',
  
  // Input actions
  FILL = 'fill',
  TYPE = 'type',
  CLEAR = 'clear',
  
  // Keyboard actions
  PRESS = 'press',
  PRESS_SEQUENTIALLY = 'pressSequentially',
  
  // Select/Checkbox actions
  SELECT = 'select',
  CHECK = 'check',
  UNCHECK = 'uncheck',
  
  // Focus/Scroll actions
  FOCUS = 'focus',
  BLUR = 'blur',
  SCROLL = 'scroll',
  SCROLL_INTO_VIEW = 'scrollIntoView',
  WAIT_FOR = 'waitFor',
  
  // Navigation actions
  NAVIGATE = 'navigate',  // Go to URL (requires value field)
  GO_BACK = 'goBack',
  GO_FORWARD = 'goForward',
  RELOAD = 'reload'
}

export interface SomCommand {
  elementRef?: string;    // Integer as string: "1", "2", "42" (optional for coord-based commands)
  action: InteractionAction;
  
  // Coordinate-based action (use when elementRef is empty/null)
  coord?: Coordinate;     // Percentage-based (x: 0-100, y: 0-100 of viewport)
  elementRelativeAbsoluteCoords?: Coordinate;  // Pixel coordinates (x, y) relative to top-left of element referenced by elementRef. Use only when elementRef points to a canvas element for interactions within the canvas.
  // Action-specific parameters
  value?: string;         // For fill/type/select/press actions
  fromCoord?: Coordinate; // For drag (start) - percentage-based
  toCoord?: Coordinate;   // For drag (end) - percentage-based
  force?: boolean;        // Force action even if not actionable
  scrollAmount?: number;  // Pixels to scroll
  scrollDirection?: 'up' | 'down' | 'left' | 'right';
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
  delay?: number;         // Delay between keystrokes for TYPE (ms)
  timeout?: number;       // Override default timeout
  durationSeconds?: number; // For waitFor action
}

export enum CommandRunStatus {
  SUCCESS = 'success',
  FAILURE = 'failure'
}

export interface CommandAttempt {
  command?: string;
  status: CommandRunStatus;
  error?: string;
}

export interface DomMutation {
  type: 'added' | 'removed' | 'modified' | 'attribute_changed';
  elementDescription: string;
  timestamp: number;
}

export interface SemanticCommandResult {
  failedAttempts: CommandAttempt[];
  successAttempt?: CommandAttempt;
  error?: string;
  status: CommandRunStatus;
  mutations?: DomMutation[];  // Only for hover/focus, filtered for relevance
}

export interface SomElement {
  somId: string;  // Simple integer as string: "1", "2", "3"
  tag: string;
  role: string;
  text: string;
  textTruncated?: boolean;  // Track if text was truncated (original length > 50 chars)
  ariaLabel: string;
  labelText: string;  // Text from associated <label> element (for getByLabel)
  placeholder: string;
  name: string;
  type: string;
  id: string;
  className: string;
  bbox: { x: number; y: number; width: number; height: number };
  hasVisiblePseudoElement?: boolean;  // True if element uses ::before or ::after for visual content
  parent?: {
    tag: string;
    role: string;
    className: string;
    text: string;
  };
}

/**
 * Typed selector (no string parsing needed)
 * Supports chaining: parent.child for scoped selectors
 */
export interface TypedSelector {
  type: 'id' | 'testId' | 'label' | 'role' | 'placeholder' | 'text' | 'title' | 'altText' | 'name' | 'locator';
  value: string;
  roleOptions?: { name?: string };  // For getByRole
  exact?: boolean;  // For text selectors: use exact matching (only if text wasn't truncated)
  parent?: TypedSelector;  // For chaining: page.locator(parent).locator(this)
  nth?: number;            // Optional index disambiguation when multiple nodes match
}

/**
 * Verification types for expect assertions
 */
export enum VerificationType {
  // Text verifications
  TEXT_CONTAINS = 'textContains',
  TEXT_EQUALS = 'textEquals',
  
  // Input verifications
  VALUE_EQUALS = 'valueEquals',
  VALUE_EMPTY = 'valueEmpty',
  
  // Visibility verifications
  IS_VISIBLE = 'isVisible',
  IS_HIDDEN = 'isHidden',
  
  // State verifications
  IS_ENABLED = 'isEnabled',
  IS_DISABLED = 'isDisabled',
  IS_CHECKED = 'isChecked',
  IS_UNCHECKED = 'isUnchecked',
  
  // Count verifications (for lists, tables, etc.)
  COUNT_EQUALS = 'countEquals',
  COUNT_GREATER_THAN = 'countGreaterThan',
  COUNT_LESS_THAN = 'countLessThan',
  
  // Attribute verifications
  HAS_CLASS = 'hasClass',
  HAS_ATTRIBUTE = 'hasAttribute'
}

/**
 * SoM verification command for expect assertions
 */
export interface SomVerification {
  verificationType: VerificationType;
  elementRef?: string;       // SoM ID (e.g., "3") - optional for count verifications
  expected?: string | number;  // Expected value/text/count
  description?: string;        // Human-readable description
  selector?: string;          // For count verifications on non-SoM elements (CSS selector)
}

/**
 * Union type: commands array can contain both actions and verifications
 */
export type SomCommandOrVerification = SomCommand | SomVerification;

/**
 * Type guard to check if command is a verification
 */
export function isSomVerification(cmd: SomCommandOrVerification): cmd is SomVerification {
  return 'verificationType' in cmd;
}

/**
 * Type guard to check if command is an action
 */
export function isSomCommand(cmd: SomCommandOrVerification): cmd is SomCommand {
  return 'action' in cmd;
}

