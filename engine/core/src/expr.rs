//! Recursive-descent expression parser and iterative tree evaluator, the
//! port of upstream's `ExprParser`/`Expr` (Expr.java). The VCVS and VCCS
//! elements evaluate their value string with this on every Newton iteration,
//! so it stays decoupled from the matrix machinery: the only context an
//! expression sees is an [`ExprState`] of the nine input values, their
//! previous-step snapshots, the last output and the clock.
//!
//! Evaluation walks the tree with an explicit work stack instead of
//! recursion: a flat operator chain such as `1+1+1+...` nests the tree one
//! level per term, past any bound, and the native stack must not care how
//! long the chain is.
//!
//! Grammar: numbers, variables `a`..`i`, `t`, `pi`, `e`, `lastoutput`,
//! `timestep`, `lasta`..`lasti`, `da`..`di` (written `dadt`, `dcdt`, ...),
//! unary `+ - !`, binary `+ - * / ^ %`, bitwise `& | >>`, logical `&& ||`,
//! comparisons `== != < > <= >=`, ternary `? :`, and the functions
//! `sin cos tan asin acos atan sinh cosh tanh abs exp log sqrt floor ceil tri
//! saw min max pwl mod step select clamp pwr pwrs`.

/// Values an expression evaluates against: the nine input slots, their
/// previous-step snapshots, the last output and the clock.
///
/// The `e` constant lives in `values[4]` at construction, exactly where
/// upstream seeds it (ExprState constructor, Expr.java:11-16), so a bare `e`
/// in an expression reads it back.
pub struct ExprState {
    /// The nine input values, `a`..`i`.
    pub values: [f64; 9],
    /// The values from the previous step, feeding `lasta`..`lasti` and
    /// `da`..`di`.
    pub last_values: [f64; 9],
    /// The element's output on the previous step, for `lastoutput`.
    pub last_output: f64,
    /// Simulated time, for `t`.
    pub t: f64,
    /// Step length feeding `timestep` and the `da`..`di` derivatives. Kept on
    /// the state so the evaluator stays decoupled from the simulation context.
    pub time_step: f64,
}

impl ExprState {
    pub fn new() -> Self {
        let mut values = [0.0; 9];
        values[4] = std::f64::consts::E;
        Self {
            values,
            last_values: [0.0; 9],
            last_output: 0.0,
            t: 0.0,
            time_step: 0.0,
        }
    }

    /// Snapshots the current values for the next step's `lasta`..`lasti` and
    /// `da`..`di`, plus the element's output for `lastoutput`
    /// (ExprState.updateLastValues, Expr.java:18-23).
    pub fn update_last_values(&mut self, last_output: f64) {
        self.last_output = last_output;
        self.last_values = self.values;
    }

    /// Zeroes the previous-step values, upstream's ExprState.reset, used on
    /// circuit reset (Expr.java:25-30). The live values and the `e` seed
    /// survive.
    pub fn reset(&mut self) {
        self.last_values = [0.0; 9];
        self.last_output = 0.0;
    }
}

impl Default for ExprState {
    fn default() -> Self {
        Self::new()
    }
}

/// A parsed expression tree. Nodes carry an opcode and a small child list,
/// the same shape the reference implementation uses (children, Expr.java:182).
#[derive(Debug)]
pub struct Expr {
    op: Op,
    children: Vec<Expr>,
}

#[derive(Clone, Copy, Debug)]
enum Op {
    Constant(f64),
    Variable(usize),
    LastVariable(usize),
    Derivative(usize),
    Time,
    LastOutput,
    TimeStep,
    Un(Un),
    Bin(Bin),
    Ternary,
    Func(Func),
}

/// Unary operators, whose children hold a single operand.
#[derive(Clone, Copy, Debug)]
enum Un {
    Negate,
    Not,
}

/// Binary operators, in increasing binding order: the parser builds a tree
/// with `*`/`/`/`^` deeper than `+`/`-`, matching upstream's precedence
/// (Expr.java:390-434).
#[derive(Clone, Copy, Debug)]
enum Bin {
    Add,
    Sub,
    Mul,
    Div,
    Pow,
    Mod,
    BitAnd,
    BitOr,
    Shift,
    And,
    Or,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

/// Function-call opcodes. `Min`, `Max` and `Pwl` are variadic; `Step` takes
/// one or two arguments; the rest take a fixed arity.
#[derive(Clone, Copy, Debug)]
enum Func {
    Sin,
    Cos,
    Tan,
    Asin,
    Acos,
    Atan,
    Sinh,
    Cosh,
    Tanh,
    Abs,
    Exp,
    Log,
    Sqrt,
    Floor,
    Ceil,
    Triangle,
    Sawtooth,
    Mod,
    Min,
    Max,
    Pwl,
    Step,
    Select,
    Clamp,
    Pwr,
    Pwrs,
}

/// One step of the explicit evaluation walk. Scheduling always queues a
/// reduction below its operand walks, so when a reduction pops off the work
/// stack its operands are sitting on top of the value stack.
enum Task<'a> {
    /// Expands a subtree: leaves push their value, operators queue their
    /// reduction and their operands above it.
    Tree(&'a Expr),
    /// Applies a unary operator to the top value.
    Un(Un),
    /// Combines the top two values with a binary operator.
    Bin(Bin),
    /// Applies a fixed one-argument function to the top value.
    Func1(Func),
    /// Combines the top two values with a fixed two-argument function.
    Func2(Func),
    /// Folds the top two values into the running min or max.
    MinMax(Func),
    /// Evaluates `step()` over its one or two stacked arguments.
    Step(usize),
    /// Clamps the three stacked values v, lo, hi into lo..hi.
    Clamp,
    /// Once the condition value is ready, schedules only the chosen branch,
    /// mirroring the ternary's lazy branches and select()'s pick.
    Branch {
        picked: &'a Expr,
        rejected: &'a Expr,
        /// select() tests strictly positive, the ternary tests nonzero.
        positive_only: bool,
    },
    /// Advances a `pwl` call's sequential read of its argument list.
    Pwl(PwlWalk<'a>),
}

/// Which argument the next completed evaluation belongs to in a
/// [`PwlWalk`], or that a segment decision is due.
#[derive(Clone, Copy)]
enum PwlStage {
    WantX,
    WantX0,
    WantY0,
    WantX1,
    WantY1,
    Decide,
}

/// Carries a `pwl` call through its strictly sequential argument reads. Each
/// stage consumes one freshly evaluated child and queues the following one,
/// mirroring upstream's loop read for read (Expr.pwl, Expr.java:154-175)
/// while keeping deep argument subtrees on the flat work stack.
struct PwlWalk<'a> {
    node: &'a Expr,
    stage: PwlStage,
    /// Start index of the next segment pair to read once the mandatory first
    /// one is in; `next + 1 >= children.len()` ends the walk.
    next: usize,
    x: f64,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

impl Drop for Expr {
    fn drop(&mut self) {
        // A flat chain nests the tree one level per term, and the generated
        // recursive drop would mirror that depth frame for frame; flatten
        // the owned children onto an explicit stack instead. Each node left
        // behind is childless, so its own drop is shallow.
        let mut pending = std::mem::take(&mut self.children);
        while let Some(mut node) = pending.pop() {
            pending.append(&mut node.children);
        }
    }
}

impl Expr {
    fn constant(v: f64) -> Self {
        Self {
            op: Op::Constant(v),
            children: Vec::new(),
        }
    }
    fn time() -> Self {
        Self {
            op: Op::Time,
            children: Vec::new(),
        }
    }
    fn last_output() -> Self {
        Self {
            op: Op::LastOutput,
            children: Vec::new(),
        }
    }
    fn time_step() -> Self {
        Self {
            op: Op::TimeStep,
            children: Vec::new(),
        }
    }
    fn variable(i: usize) -> Self {
        Self {
            op: Op::Variable(i),
            children: Vec::new(),
        }
    }
    fn last_variable(i: usize) -> Self {
        Self {
            op: Op::LastVariable(i),
            children: Vec::new(),
        }
    }
    fn derivative(i: usize) -> Self {
        Self {
            op: Op::Derivative(i),
            children: Vec::new(),
        }
    }
    fn unary(op: Un, a: Expr) -> Self {
        Self {
            op: Op::Un(op),
            children: vec![a],
        }
    }
    fn binary(op: Bin, a: Expr, b: Expr) -> Self {
        Self {
            op: Op::Bin(op),
            children: vec![a, b],
        }
    }
    fn ternary(cond: Expr, a: Expr, b: Expr) -> Self {
        Self {
            op: Op::Ternary,
            children: vec![cond, a, b],
        }
    }
    fn func(f: Func, children: Vec<Expr>) -> Self {
        Self {
            op: Op::Func(f),
            children,
        }
    }

    /// Evaluates the tree against `state`, opcode for opcode with the
    /// reference switch (Expr.java:47-152).
    ///
    /// The walk is deliberately iterative: the parser bounds grammar nesting,
    /// but a flat chain such as `1+1+1+...` builds a tree one level per term
    /// with no nesting at all, and a recursive walk would follow it straight
    /// off the stack.
    pub fn eval(&self, state: &ExprState) -> f64 {
        let mut tasks = vec![Task::Tree(self)];
        let mut vals: Vec<f64> = Vec::new();
        while let Some(task) = tasks.pop() {
            match task {
                Task::Tree(e) => e.schedule(&mut tasks, &mut vals, state),
                Task::Un(op) => {
                    let a = pop_operand(&mut vals);
                    vals.push(match op {
                        Un::Negate => -a,
                        Un::Not => {
                            if a == 0.0 {
                                1.0
                            } else {
                                0.0
                            }
                        }
                    });
                }
                Task::Bin(op) => {
                    let b = pop_operand(&mut vals);
                    let a = pop_operand(&mut vals);
                    vals.push(bin_apply(op, a, b));
                }
                Task::Func1(f) => {
                    let a = pop_operand(&mut vals);
                    vals.push(func1_apply(f, a));
                }
                Task::Func2(f) => {
                    let b = pop_operand(&mut vals);
                    let a = pop_operand(&mut vals);
                    vals.push(func2_apply(f, a, b));
                }
                Task::MinMax(f) => {
                    let b = pop_operand(&mut vals);
                    let a = pop_operand(&mut vals);
                    // The fold order stays left to right, min(a,b,c) folding
                    // as min(min(a,b),c) like the reference loop.
                    vals.push(match f {
                        Func::Min => a.min(b),
                        Func::Max => a.max(b),
                        _ => unreachable!("only min and max fold"),
                    });
                }
                Task::Step(argc) => {
                    // The reference returns 0 both above the threshold and
                    // below zero (Expr.java:110-113).
                    if argc == 1 {
                        let x = pop_operand(&mut vals);
                        vals.push(if x < 0.0 { 0.0 } else { 1.0 });
                    } else {
                        let thr = pop_operand(&mut vals);
                        let x = pop_operand(&mut vals);
                        vals.push(if x > thr || x < 0.0 { 0.0 } else { 1.0 });
                    }
                }
                Task::Clamp => {
                    let hi = pop_operand(&mut vals);
                    let lo = pop_operand(&mut vals);
                    let v = pop_operand(&mut vals);
                    vals.push(v.max(lo).min(hi));
                }
                Task::Branch {
                    picked,
                    rejected,
                    positive_only,
                } => {
                    let cond = pop_operand(&mut vals);
                    // select() picks on strictly positive, the ternary on
                    // nonzero; the rejected branch is never walked, exactly
                    // like the lazy recursion it replaces.
                    let hit = if positive_only {
                        cond > 0.0
                    } else {
                        cond != 0.0
                    };
                    tasks.push(Task::Tree(if hit { picked } else { rejected }));
                }
                Task::Pwl(walk) => pwl_step(walk, &mut tasks, &mut vals),
            }
        }
        // Every reduction consumed what its operand walks pushed, so only
        // the root's value is left.
        debug_assert_eq!(vals.len(), 1);
        vals.pop().unwrap_or(f64::NAN)
    }

    /// Queues `self`'s contribution to the work walk: a leaf pushes its value
    /// straight onto the value stack, a compound node queues its reduction
    /// first and its operands above it, so the stack's LIFO order evaluates
    /// operands left to right and reduces last.
    fn schedule<'a>(&'a self, tasks: &mut Vec<Task<'a>>, vals: &mut Vec<f64>, state: &ExprState) {
        match self.op {
            Op::Constant(v) => vals.push(v),
            Op::Variable(i) => vals.push(state.values[i]),
            Op::LastVariable(i) => vals.push(state.last_values[i]),
            // Upstream divides by SimulationManager.theSim.timeStep; the port
            // carries the same value on the state so the evaluator needs no
            // wider context (Expr.java:145-146).
            Op::Derivative(i) => {
                vals.push((state.values[i] - state.last_values[i]) / state.time_step)
            }
            Op::Time => vals.push(state.t),
            Op::LastOutput => vals.push(state.last_output),
            Op::TimeStep => vals.push(state.time_step),
            Op::Un(op) => {
                tasks.push(Task::Un(op));
                tasks.push(Task::Tree(&self.children[0]));
            }
            Op::Bin(op) => {
                tasks.push(Task::Bin(op));
                tasks.push(Task::Tree(&self.children[1]));
                tasks.push(Task::Tree(&self.children[0]));
            }
            Op::Ternary => {
                tasks.push(Task::Branch {
                    picked: &self.children[1],
                    rejected: &self.children[2],
                    positive_only: false,
                });
                tasks.push(Task::Tree(&self.children[0]));
            }
            Op::Func(f) => self.schedule_func(f, tasks),
        }
    }

    /// Queues a function call. Fixed arities reduce straight off the stack;
    /// variadic min/max interleave fold steps between their operands so the
    /// fold order stays left to right; select() picks a branch; pwl hands its
    /// argument list to a walker that reads one child per round trip.
    fn schedule_func<'a>(&'a self, f: Func, tasks: &mut Vec<Task<'a>>) {
        let c = &self.children;
        match f {
            Func::Min | Func::Max => {
                for child in c[1..].iter().rev() {
                    tasks.push(Task::MinMax(f));
                    tasks.push(Task::Tree(child));
                }
                tasks.push(Task::Tree(&c[0]));
            }
            Func::Pwl => {
                tasks.push(Task::Pwl(PwlWalk {
                    node: self,
                    stage: PwlStage::WantX,
                    next: 3,
                    x: 0.0,
                    x0: 0.0,
                    y0: 0.0,
                    x1: 0.0,
                    y1: 0.0,
                }));
                tasks.push(Task::Tree(&c[0]));
            }
            Func::Step => {
                tasks.push(Task::Step(c.len()));
                // Arguments stack x beneath the optional threshold.
                for child in c.iter().rev() {
                    tasks.push(Task::Tree(child));
                }
            }
            Func::Select => {
                // select(x, y, z) is z when x > 0 and y otherwise
                // (Expr.java:114-117).
                tasks.push(Task::Branch {
                    picked: &c[2],
                    rejected: &c[1],
                    positive_only: true,
                });
                tasks.push(Task::Tree(&c[0]));
            }
            Func::Clamp => {
                tasks.push(Task::Clamp);
                for child in c.iter().rev() {
                    tasks.push(Task::Tree(child));
                }
            }
            Func::Mod | Func::Pwr | Func::Pwrs => {
                tasks.push(Task::Func2(f));
                tasks.push(Task::Tree(&c[1]));
                tasks.push(Task::Tree(&c[0]));
            }
            // Everything else in the table takes exactly one argument; a new
            // arity needs its own case here rather than falling in.
            _ => {
                tasks.push(Task::Func1(f));
                tasks.push(Task::Tree(&c[0]));
            }
        }
    }
}

/// The arithmetic behind [`Bin`], the reference switch's binary cases
/// (Expr.java:63-103).
fn bin_apply(op: Bin, a: f64, b: f64) -> f64 {
    match op {
        Bin::Add => a + b,
        Bin::Sub => a - b,
        Bin::Mul => a * b,
        Bin::Div => a / b,
        Bin::Pow => a.powf(b),
        Bin::Mod => a % b,
        Bin::BitAnd => (as_int(a) & as_int(b)) as f64,
        Bin::BitOr => (as_int(a) | as_int(b)) as f64,
        // Java masks an int shift count to its low five bits
        // (JLS 15.19), which is also what a wasm release shift
        // does; masking keeps dev builds from panicking on
        // out-of-range counts and all three bit-identical
        // (Expr.java:89).
        Bin::Shift => (as_int(a) >> (as_int(b) & 31)) as f64,
        Bin::And => {
            if a != 0.0 && b != 0.0 {
                1.0
            } else {
                0.0
            }
        }
        Bin::Or => {
            if a != 0.0 || b != 0.0 {
                1.0
            } else {
                0.0
            }
        }
        Bin::Eq => {
            if a == b {
                1.0
            } else {
                0.0
            }
        }
        Bin::Ne => {
            if a != b {
                1.0
            } else {
                0.0
            }
        }
        Bin::Lt => {
            if a < b {
                1.0
            } else {
                0.0
            }
        }
        Bin::Le => {
            if a <= b {
                1.0
            } else {
                0.0
            }
        }
        Bin::Gt => {
            if a > b {
                1.0
            } else {
                0.0
            }
        }
        Bin::Ge => {
            if a >= b {
                1.0
            } else {
                0.0
            }
        }
    }
}

/// Fixed one-argument function bodies (Expr.java:66-86, 118-123).
fn func1_apply(f: Func, a: f64) -> f64 {
    match f {
        Func::Sin => a.sin(),
        Func::Cos => a.cos(),
        Func::Tan => a.tan(),
        Func::Asin => a.asin(),
        Func::Acos => a.acos(),
        Func::Atan => a.atan(),
        Func::Sinh => a.sinh(),
        Func::Cosh => a.cosh(),
        Func::Tanh => a.tanh(),
        Func::Abs => a.abs(),
        Func::Exp => a.exp(),
        // Upstream's Math.log is the natural logarithm (Expr.java:78).
        Func::Log => a.ln(),
        Func::Sqrt => a.sqrt(),
        Func::Floor => a.floor(),
        Func::Ceil => a.ceil(),
        Func::Triangle => {
            let x = posmod(a, std::f64::consts::TAU) / std::f64::consts::PI;
            if x < 1.0 {
                -1.0 + 2.0 * x
            } else {
                3.0 - 2.0 * x
            }
        }
        Func::Sawtooth => posmod(a, std::f64::consts::TAU) / std::f64::consts::PI - 1.0,
        _ => unreachable!("scheduler emits one-argument functions only"),
    }
}

/// Fixed two-argument function bodies beyond plain infix arithmetic
/// (Expr.java:118-127).
fn func2_apply(f: Func, a: f64, b: f64) -> f64 {
    match f {
        Func::Mod => a % b,
        Func::Pwr => a.abs().powf(b),
        Func::Pwrs => {
            if a < 0.0 {
                -(-a).powf(b)
            } else {
                a.powf(b)
            }
        }
        _ => unreachable!("scheduler emits two-argument functions only"),
    }
}

/// Advances one round of a `pwl` walk: consumes the child value the
/// scheduler just produced, then either queues the next argument read or
/// lands the segment result, mirroring upstream's loop
/// (Expr.pwl, Expr.java:154-175).
fn pwl_step<'a>(mut w: PwlWalk<'a>, tasks: &mut Vec<Task<'a>>, vals: &mut Vec<f64>) {
    // Detach the node reference up front so the child borrows do not ride on
    // the owned frame shuffling through the work stack.
    let node: &'a Expr = w.node;
    let c = &node.children;
    match w.stage {
        PwlStage::WantX => {
            w.x = pop_operand(vals);
            w.stage = PwlStage::WantX0;
            tasks.push(Task::Pwl(w));
            tasks.push(Task::Tree(&c[1]));
        }
        PwlStage::WantX0 => {
            w.x0 = pop_operand(vals);
            w.stage = PwlStage::WantY0;
            tasks.push(Task::Pwl(w));
            tasks.push(Task::Tree(&c[2]));
        }
        PwlStage::WantY0 => {
            w.y0 = pop_operand(vals);
            // Constant before the first abscissa, and with no complete
            // segment there is nothing to interpolate, so the first output
            // holds in both cases.
            if w.x < w.x0 || c.len() < 5 {
                vals.push(w.y0);
            } else {
                w.stage = PwlStage::WantX1;
                let next_child = &c[w.next];
                tasks.push(Task::Pwl(w));
                tasks.push(Task::Tree(next_child));
            }
        }
        PwlStage::WantX1 => {
            w.x1 = pop_operand(vals);
            w.stage = PwlStage::WantY1;
            let next_child = &c[w.next + 1];
            tasks.push(Task::Pwl(w));
            tasks.push(Task::Tree(next_child));
        }
        PwlStage::WantY1 => {
            w.y1 = pop_operand(vals);
            w.next += 2;
            w.stage = PwlStage::Decide;
            tasks.push(Task::Pwl(w));
        }
        PwlStage::Decide => {
            if w.x < w.x1 {
                vals.push(w.y0 + (w.x - w.x0) * (w.y1 - w.y0) / (w.x1 - w.x0));
            } else if w.next + 1 >= c.len() {
                // Past the last abscissa the last ordinate holds.
                vals.push(w.y1);
            } else {
                w.x0 = w.x1;
                w.y0 = w.y1;
                w.stage = PwlStage::WantX1;
                let next_child = &c[w.next];
                tasks.push(Task::Pwl(w));
                tasks.push(Task::Tree(next_child));
            }
        }
    }
}
/// Java's `(int)` cast on a double: truncate toward zero and wrap into i32
/// range, matching the reference implementation's bitwise operators
/// (Expr.java:87-89).
#[inline]
fn as_int(v: f64) -> i32 {
    (v.trunc() as i64) as i32
}

/// Pops an operand that the matching [`Task::Tree`] walk pushed. Every
/// reduction is scheduled above its operands, so a miss here would be a
/// scheduling bug, never something file input can reach.
fn pop_operand(vals: &mut Vec<f64>) -> f64 {
    vals.pop().expect("scheduled operand missing")
}

/// Modulo that never returns negative for a positive modulus, upstream's
/// `posmod` (Expr.java:177-180).
fn posmod(x: f64, y: f64) -> f64 {
    let m = x % y;
    if m >= 0.0 {
        m
    } else {
        m + y
    }
}

/// Parses `input` into an expression tree, lowercasing it first like the
/// upstream constructor (ExprParser, Expr.java:561-567). Returns a parse
/// error message on failure and never panics.
pub fn parse(input: &str) -> Result<Expr, String> {
    let lower = input.to_lowercase();
    let toks = lex(&lower)?;
    let mut p = Parser {
        toks,
        pos: 0,
        err: None,
        depth: 0,
    };
    let e = p.parse_expr();
    match p.err {
        Some(err) => Err(err),
        None => Ok(e),
    }
}

/// Recursion budget for the parser, counted in grammar levels. Every paren
/// nesting level costs about 13 frames through the precedence chain, and both
/// the ternary's right-recursion and unary operator chains descend without
/// consuming input, so nothing bounds the parsing recursion naturally:
/// thousands of nested parens used to overflow the wasm stack and trap the
/// instance. Legitimate files sit far below this, the deepest bundled
/// expression being single digits deep (`pwl` argument lists are flat,
/// sequential calls do not accumulate depth), so 64 leaves more than 10x
/// headroom while capping worst-case parser recursion near 850 frames,
/// comfortably inside the wasm stack.
///
/// This bound covers parsing only, and it can afford to: evaluation shares
/// the concern through construction instead, [`Expr::eval`] walking the
/// finished tree on an explicit work stack rather than recursion, so a flat
/// operator chain, which nests no grammar level at all, stays safe however
/// long it grows.
const MAX_EXPR_DEPTH: usize = 64;

#[derive(Debug, Clone)]
enum Tok {
    Num(f64),
    Word(String),
}

/// Tokenises the input into numbers, whole words and single or double
/// operator symbols. The doubled-operator set matches upstream's lexer
/// (Expr.java:274-281): `|| && >> << == <= >= !=`.
fn lex(input: &str) -> Result<Vec<Tok>, String> {
    let bytes = input.as_bytes();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if c.is_ascii_digit() || c == b'.' {
            let (v, next) = lex_number(bytes, i)?;
            toks.push(Tok::Num(v));
            i = next;
            continue;
        }
        if c.is_ascii_alphabetic() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
                i += 1;
            }
            toks.push(Tok::Word(input[start..i].to_string()));
            continue;
        }
        if c >= 0x80 {
            // Non-ASCII: consume one whole char as an unrecognised token
            // rather than splitting bytes.
            let ch = input[i..].chars().next().unwrap_or_default();
            let w = ch.to_string();
            i += ch.len_utf8();
            toks.push(Tok::Word(w));
            continue;
        }
        let two = i + 1 < bytes.len()
            && ((bytes[i + 1] == c && matches!(c, b'|' | b'&' | b'<' | b'>' | b'='))
                || (matches!(c, b'<' | b'>' | b'!') && bytes[i + 1] == b'='));
        if two {
            toks.push(Tok::Word(input[i..i + 2].to_string()));
            i += 2;
        } else {
            toks.push(Tok::Word(input[i..i + 1].to_string()));
            i += 1;
        }
    }
    Ok(toks)
}

/// Reads a number with an optional `e` exponent at `bytes[start]`.
fn lex_number(bytes: &[u8], start: usize) -> Result<(f64, usize), String> {
    let mut end = start;
    while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'.') {
        end += 1;
    }
    if end < bytes.len() && bytes[end] == b'e' {
        let mut k = end + 1;
        if k < bytes.len() && (bytes[k] == b'+' || bytes[k] == b'-') {
            k += 1;
        }
        if k < bytes.len() && bytes[k].is_ascii_digit() {
            end = k;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
        }
    }
    let tok = std::str::from_utf8(&bytes[start..end]).unwrap();
    let v = tok
        .parse::<f64>()
        .map_err(|_| format!("invalid number: {tok}"))?;
    Ok((v, end))
}

/// The slot index for a single variable letter `a`..`i`.
fn var_index(w: &str) -> Option<usize> {
    let b = w.as_bytes();
    if b.len() == 1 && (b'a'..=b'i').contains(&b[0]) {
        Some((b[0] - b'a') as usize)
    } else {
        None
    }
}

struct Parser {
    toks: Vec<Tok>,
    pos: usize,
    err: Option<String>,
    /// Current recursion level against [`MAX_EXPR_DEPTH`], counted around the
    /// two entry points that can nest without consuming input.
    depth: usize,
}

impl Parser {
    fn set_error(&mut self, msg: String) {
        if self.err.is_none() {
            self.err = Some(msg);
        }
    }

    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos)
    }

    /// Consumes the current token when it equals `w`, Java's `skip`
    /// (Expr.java:287-292).
    fn skip_word(&mut self, w: &str) -> bool {
        if matches!(self.peek(), Some(Tok::Word(t)) if t == w) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    /// Java's `skipOrError`: consumes `w` or records the first parse error
    /// (Expr.java:299-303).
    fn skip_or_error(&mut self, w: &str) {
        if !self.skip_word(w) {
            let got = match self.peek() {
                Some(Tok::Word(t)) => t.clone(),
                Some(Tok::Num(v)) => v.to_string(),
                None => "end of input".to_string(),
            };
            self.set_error(format!("expected {w}, got {got}"));
        }
    }

    fn parse_expr(&mut self) -> Expr {
        if self.peek().is_none() {
            // Empty input evaluates to zero, like upstream's parseExpression
            // when the first token is empty (Expr.java:306-307).
            return Expr::constant(0.0);
        }
        let e = self.parse();
        if let Some(tok) = self.peek() {
            let got = match tok {
                Tok::Num(v) => v.to_string(),
                Tok::Word(w) => w.clone(),
            };
            self.set_error(format!("unexpected token: {got}"));
        }
        e
    }

    /// Top of the grammar, where the ternary sits: `parseOr ? parseOr : parse`
    /// (Expr.java:314-326). Guarded because three paths recurse back into it
    /// without bound: parenthesised groups (through `parse_term`), function
    /// arguments, and the ternary's own right-recursive else branch.
    fn parse(&mut self) -> Expr {
        if self.depth >= MAX_EXPR_DEPTH {
            self.set_error("expression nested too deeply".to_string());
            return Expr::constant(0.0);
        }
        self.depth += 1;
        let cond = self.parse_or();
        let e = if self.skip_word("?") {
            let a = self.parse_or();
            self.skip_or_error(":");
            let b = self.parse();
            Expr::ternary(cond, a, b)
        } else {
            cond
        };
        self.depth -= 1;
        e
    }

    fn parse_or(&mut self) -> Expr {
        let mut e = self.parse_and();
        while self.skip_word("||") {
            let rhs = self.parse_and();
            e = Expr::binary(Bin::Or, e, rhs);
        }
        e
    }

    fn parse_and(&mut self) -> Expr {
        let mut e = self.parse_bit_or();
        while self.skip_word("&&") {
            let rhs = self.parse_bit_or();
            e = Expr::binary(Bin::And, e, rhs);
        }
        e
    }

    fn parse_bit_or(&mut self) -> Expr {
        let mut e = self.parse_bit_and();
        while self.skip_word("|") {
            let rhs = self.parse_bit_and();
            e = Expr::binary(Bin::BitOr, e, rhs);
        }
        e
    }

    fn parse_bit_and(&mut self) -> Expr {
        let mut e = self.parse_equals();
        while self.skip_word("&") {
            let rhs = self.parse_equals();
            e = Expr::binary(Bin::BitAnd, e, rhs);
        }
        e
    }

    fn parse_equals(&mut self) -> Expr {
        let e = self.parse_compare();
        if self.skip_word("==") {
            let rhs = self.parse_compare();
            Expr::binary(Bin::Eq, e, rhs)
        } else {
            e
        }
    }

    fn parse_compare(&mut self) -> Expr {
        let e = self.parse_shift();
        if self.skip_word("<=") {
            let rhs = self.parse_shift();
            Expr::binary(Bin::Le, e, rhs)
        } else if self.skip_word(">=") {
            let rhs = self.parse_shift();
            Expr::binary(Bin::Ge, e, rhs)
        } else if self.skip_word("!=") {
            let rhs = self.parse_shift();
            Expr::binary(Bin::Ne, e, rhs)
        } else if self.skip_word("<") {
            let rhs = self.parse_shift();
            Expr::binary(Bin::Lt, e, rhs)
        } else if self.skip_word(">") {
            let rhs = self.parse_shift();
            Expr::binary(Bin::Gt, e, rhs)
        } else {
            e
        }
    }

    fn parse_shift(&mut self) -> Expr {
        let mut e = self.parse_add();
        while self.skip_word(">>") {
            let rhs = self.parse_add();
            e = Expr::binary(Bin::Shift, e, rhs);
        }
        e
    }

    fn parse_add(&mut self) -> Expr {
        let mut e = self.parse_mult();
        loop {
            if self.skip_word("+") {
                let rhs = self.parse_mult();
                e = Expr::binary(Bin::Add, e, rhs);
            } else if self.skip_word("-") {
                let rhs = self.parse_mult();
                e = Expr::binary(Bin::Sub, e, rhs);
            } else {
                break;
            }
        }
        e
    }

    fn parse_mult(&mut self) -> Expr {
        let mut e = self.parse_uminus();
        loop {
            if self.skip_word("*") {
                let rhs = self.parse_uminus();
                e = Expr::binary(Bin::Mul, e, rhs);
            } else if self.skip_word("/") {
                let rhs = self.parse_uminus();
                e = Expr::binary(Bin::Div, e, rhs);
            } else if self.skip_word("%") {
                // Upstream only has `mod(a, b)` as a function; the infix form
                // is a port extension at the same precedence as `*` and `/`.
                let rhs = self.parse_uminus();
                e = Expr::binary(Bin::Mod, e, rhs);
            } else {
                break;
            }
        }
        e
    }

    /// Unary operators bind tighter than `^`, so `-2^2` parses as `-(2^2)`
    /// (Expr.java:416-423). A leading `+` is a no-op. Only the `-`/`!`
    /// branches recurse back down here, and they do it through
    /// [`Parser::parse_unary_step`], which carries the depth counter: the
    /// plain pass-through to `parse_pow` must stay free, or every paren level
    /// would pay the counter twice.
    fn parse_uminus(&mut self) -> Expr {
        self.skip_word("+");
        if self.skip_word("!") {
            let e = self.parse_unary_step();
            Expr::unary(Un::Not, e)
        } else if self.skip_word("-") {
            let e = self.parse_unary_step();
            Expr::unary(Un::Negate, e)
        } else {
            self.parse_pow()
        }
    }

    /// One `-` or `!` step, guarded against [`MAX_EXPR_DEPTH`] because an
    /// operator chain descends without consuming any operand.
    fn parse_unary_step(&mut self) -> Expr {
        if self.depth >= MAX_EXPR_DEPTH {
            self.set_error("expression nested too deeply".to_string());
            return Expr::constant(0.0);
        }
        self.depth += 1;
        let e = self.parse_uminus();
        self.depth -= 1;
        e
    }

    fn parse_pow(&mut self) -> Expr {
        let mut e = self.parse_term();
        while self.skip_word("^") {
            let rhs = self.parse_term();
            e = Expr::binary(Bin::Pow, e, rhs);
        }
        e
    }

    fn parse_func(&mut self, f: Func) -> Expr {
        self.skip_or_error("(");
        let e = self.parse();
        self.skip_or_error(")");
        Expr::func(f, vec![e])
    }

    fn parse_func_multi(&mut self, f: Func, min_args: usize, max_args: usize) -> Expr {
        let mut args = 1;
        self.skip_or_error("(");
        let e1 = self.parse();
        let mut children = vec![e1];
        while self.skip_word(",") {
            children.push(self.parse());
            args += 1;
        }
        self.skip_or_error(")");
        if args < min_args || args > max_args {
            self.set_error(format!("bad number of function args: {args}"));
        }
        Expr::func(f, children)
    }

    /// A primary term: a parenthesised expression, `t`, a variable, a
    /// `lastx`/`dxdt` form, a keyword, a function call, or a number. The
    /// checks run in upstream's order, which matters because `t`, the single
    /// letters and the `last...` prefix all start with the same characters
    /// (Expr.java:459-559).
    fn parse_term(&mut self) -> Expr {
        if self.skip_word("(") {
            let e = self.parse();
            self.skip_or_error(")");
            return e;
        }
        if self.skip_word("t") {
            return Expr::time();
        }
        match self.peek() {
            Some(Tok::Num(v)) => {
                let v = *v;
                self.pos += 1;
                Expr::constant(v)
            }
            Some(Tok::Word(w)) => {
                let w = w.clone();
                self.pos += 1;
                if w.len() == 1 {
                    if let Some(i) = var_index(&w) {
                        return Expr::variable(i);
                    }
                }
                if w.len() == 5 && w.starts_with("last") {
                    if let Some(i) = var_index(&w[4..]) {
                        return Expr::last_variable(i);
                    }
                }
                // The derivative form is `d` + letter + `dt`, e.g. `dadt`
                // (Expr.java:481-487).
                if w.len() == 4 && w.starts_with('d') && w.ends_with("dt") {
                    if let Some(i) = var_index(&w[1..2]) {
                        return Expr::derivative(i);
                    }
                }
                match w.as_str() {
                    "lastoutput" => Expr::last_output(),
                    "timestep" => Expr::time_step(),
                    "pi" => Expr::constant(std::f64::consts::PI),
                    "sin" => self.parse_func(Func::Sin),
                    "cos" => self.parse_func(Func::Cos),
                    "tan" => self.parse_func(Func::Tan),
                    "asin" => self.parse_func(Func::Asin),
                    "acos" => self.parse_func(Func::Acos),
                    "atan" => self.parse_func(Func::Atan),
                    "sinh" => self.parse_func(Func::Sinh),
                    "cosh" => self.parse_func(Func::Cosh),
                    "tanh" => self.parse_func(Func::Tanh),
                    "abs" => self.parse_func(Func::Abs),
                    "exp" => self.parse_func(Func::Exp),
                    "log" => self.parse_func(Func::Log),
                    "sqrt" => self.parse_func(Func::Sqrt),
                    "floor" => self.parse_func(Func::Floor),
                    "ceil" => self.parse_func(Func::Ceil),
                    "tri" => self.parse_func(Func::Triangle),
                    "saw" => self.parse_func(Func::Sawtooth),
                    "min" => self.parse_func_multi(Func::Min, 2, 1000),
                    "max" => self.parse_func_multi(Func::Max, 2, 1000),
                    // x, x0, y0 is the floor: the walker reads child 2 for
                    // its first ordinate, so shorter lists must never reach it.
                    "pwl" => self.parse_func_multi(Func::Pwl, 3, 1000),
                    "mod" => self.parse_func_multi(Func::Mod, 2, 2),
                    "step" => self.parse_func_multi(Func::Step, 1, 2),
                    "select" => self.parse_func_multi(Func::Select, 3, 3),
                    "clamp" => self.parse_func_multi(Func::Clamp, 3, 3),
                    "pwr" => self.parse_func_multi(Func::Pwr, 2, 2),
                    "pwrs" => self.parse_func_multi(Func::Pwrs, 2, 2),
                    _ => {
                        self.set_error(format!("unrecognized token: {w}"));
                        Expr::constant(0.0)
                    }
                }
            }
            None => {
                self.set_error("unexpected end of input".to_string());
                Expr::constant(0.0)
            }
        }
    }
}
