/**
 * Set-of-Marks (SoM) Type Definitions
 * Types for visual element identification and interaction
 */
export interface Coordinate {
    x: number;
    y: number;
}
export declare enum InteractionAction {
    CLICK = "click",
    DOUBLE_CLICK = "doubleClick",
    RIGHT_CLICK = "rightClick",
    HOVER = "hover",
    MOUSE_DOWN = "mouseDown",
    MOUSE_UP = "mouseUp",
    DRAG = "drag",
    FILL = "fill",
    TYPE = "type",
    CLEAR = "clear",
    PRESS = "press",
    PRESS_SEQUENTIALLY = "pressSequentially",
    SELECT = "select",
    CHECK = "check",
    UNCHECK = "uncheck",
    FOCUS = "focus",
    BLUR = "blur",
    SCROLL = "scroll",
    SCROLL_INTO_VIEW = "scrollIntoView",
    WAIT_FOR = "waitFor",
    NAVIGATE = "navigate",// Go to URL (requires value field)
    GO_BACK = "goBack",
    GO_FORWARD = "goForward",
    RELOAD = "reload"
}
export interface SomCommand {
    elementRef?: string;
    action: InteractionAction;
    coord?: Coordinate;
    elementRelativeAbsoluteCoords?: Coordinate;
    value?: string;
    fromCoord?: Coordinate;
    toCoord?: Coordinate;
    force?: boolean;
    scrollAmount?: number;
    scrollDirection?: 'up' | 'down' | 'left' | 'right';
    button?: 'left' | 'right' | 'middle';
    clickCount?: number;
    modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
    delay?: number;
    timeout?: number;
    durationSeconds?: number;
}
export declare enum CommandRunStatus {
    SUCCESS = "success",
    FAILURE = "failure"
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
    mutations?: DomMutation[];
}
export interface SomElement {
    somId: string;
    tag: string;
    role: string;
    text: string;
    textTruncated?: boolean;
    ariaLabel: string;
    labelText: string;
    placeholder: string;
    name: string;
    type: string;
    id: string;
    className: string;
    bbox: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    hasVisiblePseudoElement?: boolean;
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
    roleOptions?: {
        name?: string;
    };
    exact?: boolean;
    parent?: TypedSelector;
    nth?: number;
}
/**
 * Verification types for expect assertions
 */
export declare enum VerificationType {
    TEXT_CONTAINS = "textContains",
    TEXT_EQUALS = "textEquals",
    VALUE_EQUALS = "valueEquals",
    VALUE_EMPTY = "valueEmpty",
    IS_VISIBLE = "isVisible",
    IS_HIDDEN = "isHidden",
    IS_ENABLED = "isEnabled",
    IS_DISABLED = "isDisabled",
    IS_CHECKED = "isChecked",
    IS_UNCHECKED = "isUnchecked",
    COUNT_EQUALS = "countEquals",
    COUNT_GREATER_THAN = "countGreaterThan",
    COUNT_LESS_THAN = "countLessThan",
    HAS_CLASS = "hasClass",
    HAS_ATTRIBUTE = "hasAttribute"
}
/**
 * SoM verification command for expect assertions
 */
export interface SomVerification {
    verificationType: VerificationType;
    elementRef?: string;
    expected?: string | number;
    description?: string;
    selector?: string;
}
/**
 * Union type: commands array can contain both actions and verifications
 */
export type SomCommandOrVerification = SomCommand | SomVerification;
/**
 * Type guard to check if command is a verification
 */
export declare function isSomVerification(cmd: SomCommandOrVerification): cmd is SomVerification;
/**
 * Type guard to check if command is an action
 */
export declare function isSomCommand(cmd: SomCommandOrVerification): cmd is SomCommand;
