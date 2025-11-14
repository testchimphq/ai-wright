"use strict";
/**
 * Set-of-Marks (SoM) Type Definitions
 * Types for visual element identification and interaction
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VerificationType = exports.CommandRunStatus = exports.InteractionAction = void 0;
exports.isSomVerification = isSomVerification;
exports.isSomCommand = isSomCommand;
var InteractionAction;
(function (InteractionAction) {
    // Click actions
    InteractionAction["CLICK"] = "click";
    InteractionAction["DOUBLE_CLICK"] = "doubleClick";
    InteractionAction["RIGHT_CLICK"] = "rightClick";
    // Mouse actions
    InteractionAction["HOVER"] = "hover";
    InteractionAction["MOUSE_DOWN"] = "mouseDown";
    InteractionAction["MOUSE_UP"] = "mouseUp";
    InteractionAction["DRAG"] = "drag";
    // Input actions
    InteractionAction["FILL"] = "fill";
    InteractionAction["TYPE"] = "type";
    InteractionAction["CLEAR"] = "clear";
    // Keyboard actions
    InteractionAction["PRESS"] = "press";
    InteractionAction["PRESS_SEQUENTIALLY"] = "pressSequentially";
    // Select/Checkbox actions
    InteractionAction["SELECT"] = "select";
    InteractionAction["CHECK"] = "check";
    InteractionAction["UNCHECK"] = "uncheck";
    // Focus/Scroll actions
    InteractionAction["FOCUS"] = "focus";
    InteractionAction["BLUR"] = "blur";
    InteractionAction["SCROLL"] = "scroll";
    InteractionAction["SCROLL_INTO_VIEW"] = "scrollIntoView";
    InteractionAction["WAIT_FOR"] = "waitFor";
    // Navigation actions
    InteractionAction["NAVIGATE"] = "navigate";
    InteractionAction["GO_BACK"] = "goBack";
    InteractionAction["GO_FORWARD"] = "goForward";
    InteractionAction["RELOAD"] = "reload";
})(InteractionAction || (exports.InteractionAction = InteractionAction = {}));
var CommandRunStatus;
(function (CommandRunStatus) {
    CommandRunStatus["SUCCESS"] = "success";
    CommandRunStatus["FAILURE"] = "failure";
})(CommandRunStatus || (exports.CommandRunStatus = CommandRunStatus = {}));
/**
 * Verification types for expect assertions
 */
var VerificationType;
(function (VerificationType) {
    // Text verifications
    VerificationType["TEXT_CONTAINS"] = "textContains";
    VerificationType["TEXT_EQUALS"] = "textEquals";
    // Input verifications
    VerificationType["VALUE_EQUALS"] = "valueEquals";
    VerificationType["VALUE_EMPTY"] = "valueEmpty";
    // Visibility verifications
    VerificationType["IS_VISIBLE"] = "isVisible";
    VerificationType["IS_HIDDEN"] = "isHidden";
    // State verifications
    VerificationType["IS_ENABLED"] = "isEnabled";
    VerificationType["IS_DISABLED"] = "isDisabled";
    VerificationType["IS_CHECKED"] = "isChecked";
    VerificationType["IS_UNCHECKED"] = "isUnchecked";
    // Count verifications (for lists, tables, etc.)
    VerificationType["COUNT_EQUALS"] = "countEquals";
    VerificationType["COUNT_GREATER_THAN"] = "countGreaterThan";
    VerificationType["COUNT_LESS_THAN"] = "countLessThan";
    // Attribute verifications
    VerificationType["HAS_CLASS"] = "hasClass";
    VerificationType["HAS_ATTRIBUTE"] = "hasAttribute";
})(VerificationType || (exports.VerificationType = VerificationType = {}));
/**
 * Type guard to check if command is a verification
 */
function isSomVerification(cmd) {
    return 'verificationType' in cmd;
}
/**
 * Type guard to check if command is an action
 */
function isSomCommand(cmd) {
    return 'action' in cmd;
}
