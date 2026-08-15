/** The static reference pages: Subcircuits, Custom Logic, Controlled Source
 *  Output Function, Custom Transformer and Real Op-Amps. Hand-adapted prose
 *  from upstream's pages, in the port's menus and element names. */

import { OpenExample } from '../components';

export function SubcircuitsPage() {
  return (
    <>
      <p>You can use subcircuits to implement custom "black box" devices.</p>

      <p>
        Create and test your device, and then use labeled nodes to mark and
        label all the inputs/outputs.{' '}
        <OpenExample name="subcircuitBridgeRectifier">
          Here is an example circuit (a bridge rectifier).
        </OpenExample>
      </p>

      <p>
        Then select File &gt; Create Subcircuit, enter a model name, and click
        OK. The pins come from the labeled nodes in the selection; this will
        load the subcircuit model.
      </p>

      <p>
        Now you can create a circuit using the subcircuit model. Place a Custom
        Composite from the toolbox (the Other section), then edit it to select
        which model you want (by default it will use the one you just created).
      </p>

      <p>
        You can also use subcircuits to rearrange pins on the built-in chips.{' '}
        <OpenExample name="subcircuitTimer555Pins">Here is an example with the 555</OpenExample>.
        And{' '}
        <OpenExample name="subcircuitTimer555Usage">
          here is that subcircuit model being used in a circuit.
        </OpenExample>{' '}
        When you save/load this circuit, it will also save/load the subcircuit
        model so you can use it in other circuits.
      </p>

      <p>
        If you select part of a circuit before using File &gt; Create
        Subcircuit, then only the selected elements will be considered part of
        the subcircuit.
      </p>

      <p>
        A labeled node marked with the "Internal Node" flag is a private net of
        the subcircuit, not a pin. The flag is honored when a file carries it,
        but the labeled node's options do not expose the checkbox yet.
      </p>

      <h2>Pins</h2>
      <p>
        The arrangement and direction of the labeled nodes in your circuit will
        determine the arrangement of the pins when creating the symbol.
      </p>
      <p>The name of the labeled nodes can affect the look of the pin in the
        following ways:</p>
      <ul>
        <li>Naming a node "CLK" will add a "clock marker" to the symbol at that pin and hide the text.</li>
        <li>Prefixing the name with "CLK:" (as in "CLK:C1") will draw a "clock marker" on that pin in the symbol.</li>
        <li>Prefixing the name with "INV:" (as in "INV:EN") will draw an "inverter circle" on that pin in the symbol, denoting logical inversion.</li>
        <li>Prefixing the name with "/" (as in "/EN") will draw a horizontal line above the text in the symbol, also denoting logical negation.</li>
        <li>For all prefixes, the prefix itself will not be shown in the symbol, only the text after the prefix.</li>
        <li>All prefixes are purely cosmetic and do not affect the actual signal.</li>
      </ul>
      <p>
        <OpenExample name="subcircuitPinPrefixes">
          This circuit shows each prefix on its own labeled node.
        </OpenExample>
      </p>
    </>
  );
}

export function CustomLogicPage() {
  return (
    <>
      <p>
        You can implement your own simple logic devices with custom logic
        chips (located under Logic).
      </p>
      <p>
        Every custom logic device has a model name, which points to a model
        that describes how it works. You can have any number of devices with
        the same model. Editing the model changes the behavior of all devices
        that use that model.
      </p>
      <p>
        When editing the model, you specify the inputs, the outputs, some info
        text (which is shown in the lower right corner when hovering the mouse
        over a device), and the definition.
      </p>
      <p>
        The inputs (and outputs) is a comma separated list of <b>short</b> pin
        labels (one or two characters max). You can also specify inverted
        labels, like <code>/Q</code> for <span className="overline">Q</span>.
        Example: <code>A,B,/C,/D</code>.
      </p>
      <p>
        The definition is multiple lines of the form <i>input</i>
        <code>=</code>
        <i>output</i>. The first <i>input</i> pattern that matches the input
        pins is chosen, and the output pins are set to match the <i>output</i>{' '}
        pattern. The pattern can contain bit values (<code>0</code>,{' '}
        <code>1</code>), transitions (<code>+</code>, <code>-</code>),
        wildcards/don't cares (<code>?</code>), and pattern letters (
        <code>A</code>, <code>B</code>, etc.). The <i>input</i> has to be at
        least as long as the number of input pins. If it's longer, then the
        additional pattern characters will be matched against the output pins;
        this allows you to create devices with state.
      </p>
      <p>
        The output pattern can also contain <code>_</code> to indicate a
        high-impedance state.
      </p>

      <h2>3 input NAND</h2>
      <p>
        Inputs: <code>A,B,C</code>
        <br />
        Outputs: <code>X</code>
        <br />
        Definition:
      </p>
      <pre>111=0
???=1</pre>
      <p>If all three inputs are 1, the output is 0. Otherwise, it's 1.</p>

      <h2>Full adder</h2>
      <p>
        Inputs: <code>A,B,C</code>
        <br />
        Outputs: <code>S,C</code>
        <br />
        Definition:
      </p>
      <pre>111=11
110=10
011=10
101=10
100=01
010=01
001=01
000=00</pre>

      <h2>SR Latch</h2>
      <p>
        Inputs: <code>S,R</code>
        <br />
        Outputs: <code>Q,/Q</code>
        <br />
        Definition:
      </p>
      <pre>?? 00=10
10 ??=10
01 ??=01
?? AB=AB</pre>
      <p>
        The input pattern (the left side of the equals sign) matches S, R, Q,
        and <span className="overline">Q</span>, in that
        order. The right side of the equals sign specifies the resulting Q and{' '}
        <span className="overline">Q</span>.
      </p>
      <p>
        The first line sets the Q output if both outputs are low (this is
        needed when resetting the circuit). The next line sets the outputs to
        1,0 if set is high. The second line sets the outputs to 0,1 if reset
        is high. The next line keeps the outputs the same otherwise. (The
        first two letters match the input pins and the second two letters
        match the output pins. Spaces are ignored, but are added here for
        clarity.)
      </p>

      <h2>D Flip Flop</h2>
      <p>
        Inputs: <code>D,Clk</code>
        <br />
        Outputs: <code>Q,/Q</code>
        <br />
        Definition:
      </p>
      <pre>?? 00=10
0+ ??=01
1+ ??=10
?? AB=AB</pre>
      <p>
        The first line sets the Q output if both outputs are low (this is
        needed when resetting the circuit). The next two lines set the Q output
        to match the D input on a rising transition of the clock. The last line
        keeps the outputs the same otherwise.
      </p>

      <h2>JK Flip Flop</h2>
      <p>
        Inputs: <code>J,K,Clk</code>
        <br />
        Outputs: <code>Q,/Q</code>
        <br />
        Definition:
      </p>
      <pre>??? 00=10
00- AB=AB
10- ??=10
01- ??=01
11- AB=BA
??? AB=AB</pre>
      <p>
        The first line sets the Q output if both outputs are low (this is
        needed when resetting the circuit). The next four lines implement the
        JK flip flop logic on a negative transition of the clock. The last
        line keeps the outputs the same otherwise.
      </p>

      <h2>Digital Comparator</h2>
      <p>
        Inputs: <code>A2,A1,A0,B2,B1,B0</code>
        <br />
        Outputs: <code>Eq,A&gt;,A&lt;</code>
        <br />
        Definition:
      </p>
      <pre>ABC ABC=100
1?? 0??=010
A1? A0?=010
AB1 AB0=010
??? ???=001</pre>
      <p>
        The first line checks if the two inputs are equal. The next three lines
        test if A is larger. Otherwise, B must be larger.
      </p>

      <h2>3-Bit Counter</h2>
      <p>
        Inputs: <code>Clk</code>
        <br />
        Outputs: <code>A,B,C</code>
        <br />
        Definition:
      </p>
      <pre>+ AB0=AB1
+ A01=A10
+ 011=100
+ 111=000
? ABC=ABC</pre>
      <p>
        This counter counts up on positive transition of the Clk input. The
        first line handles counting up from 000, 010, 100, or 110. The second
        line handles counting up from 001 or 101. The next two lines handle
        011 and 111. The last line ensures that the output doesn't change
        unless the clock makes a positive transition.
      </p>

      <h2>3 input NAND with enable</h2>
      <p>
        Inputs: <code>A,B,C,En</code>
        <br />
        Outputs: <code>X</code>
        <br />
        Definition:
      </p>
      <pre>1111=0
???1=1
???0=_</pre>
      <p>
        Same as the 3 input NAND above, except that the output goes into a
        high-impedance state if the enable pin is low.
      </p>

      <h2>Tri-state buffer</h2>
      <p>
        Inputs: <code>A,En</code>
        <br />
        Outputs: <code>X</code>
        <br />
        Definition:
      </p>
      <pre>A1=A
?0=_</pre>
      <p>
        Output is the same as A if the enable bit is high, otherwise it goes
        into a high-impedance state.
      </p>
    </>
  );
}

export function CustomFunctionPage() {
  return (
    <>
      <p>
        The controlled source elements take an output function parameter. The
        output function takes the inputs, if any, as parameters (which will be{' '}
        <code>a</code>, <code>b</code>, etc. for a voltage-controlled source,
        or <code>i</code> for a current-controlled source). You can also
        specify <code>t</code> for the current simulation time,{' '}
        <code>timestep</code> for the timestep, <code>pi</code> for π, and{' '}
        <code>e</code> for <i>e</i> (unless there is an input <code>e</code>).
      </p>
      <p>
        The function can use arithmetic like <code>a+b</code>,{' '}
        <code>a*b</code>, <code>a^2/(b-1)</code>, etc. It can also use the
        function set <code>sin cos tan asin acos atan sinh cosh tanh abs exp
        log sqrt floor ceil tri saw min max pwl mod step select clamp pwr
        pwrs</code>, and conditional expressions like{' '}
        <code>(a &gt; 5) ? a+1 : b-2</code>.
      </p>
      <ul>
        <li><code>tri(x)</code> is like <code>sin(x)</code>, but generates a triangle waveform.</li>
        <li><code>saw(x)</code> is like <code>sin(x)</code>, but generates a sawtooth waveform.</li>
        <li>
          <code>step(x)</code> is 0 if <code>x</code> &lt; 0, and 1 otherwise
          (equivalent to <code>x &gt;= 0</code>). <code>step(x,y)</code> is 1
          if 0 &lt; <code>x</code> &lt; <code>y</code>, and 0 otherwise
          (equivalent to <code>0 &lt; x &amp;&amp; x &lt; y</code>).
        </li>
        <li><code>clamp(x,lo,hi)</code> is equal to <code>min(max(x, lo), hi)</code>.</li>
        <li>
          <code>select(x,a,b)</code> is equal to <code>b</code> if{' '}
          <code>x</code> is greater than zero, and <code>a</code> otherwise, so
          it's the same as <code>(x &gt; 0) ? b : a</code>.
        </li>
        <li>
          <code>pwl(x,x0,y0,x1,y1,...,xn,yn)</code> is short for piece-wise
          linear: the result is <code>y0</code> below <code>x0</code>, a linear
          interpolation between consecutive <code>(xi,yi)</code> pairs in
          between, and <code>yn</code> above <code>xn</code>. For example,{' '}
          <code>pwl(t,0,0,.1,5)</code> is a waveform that starts at 0 at time 0
          and then ramps to 5 over 100ms, then stays at 5.
        </li>
        <li>
          <code>dadt</code>, <code>dbdt</code>, etc. are equal to the time
          derivative of <code>a</code>, <code>b</code>, etc.{' '}
          <code>lasta</code>, <code>lastb</code>, etc. are equal to the value
          of <code>a</code>, <code>b</code>, etc. in the previous timestep.{' '}
          <code>lastoutput</code> is equal to the value of the output function
          in the previous timestep.
        </li>
      </ul>

      <h2>Examples</h2>
      <ul>
        <li><OpenExample name="vcvsResistor">Resistor</OpenExample></li>
        <li><OpenExample name="vcvsVaryingResistor">Varying Resistor</OpenExample></li>
        <li><OpenExample name="vccsOpAmp">Op-Amp</OpenExample></li>
        <li><OpenExample name="vccsOpAmpWithRails">Op-Amp With Rails</OpenExample></li>
        <li><OpenExample name="vccsMultiplier">Multiplier</OpenExample></li>
        <li><OpenExample name="vccsFullRectifier">Full Rectifier</OpenExample></li>
        <li><OpenExample name="vccsVoltageRamp">Voltage Ramp</OpenExample></li>
        <li><OpenExample name="ccvsCurrentAdder">Current Adder</OpenExample></li>
        <li><OpenExample name="vccsIntegrator">Integrator</OpenExample></li>
        <li><OpenExample name="vccsDifferentiator">Differentiator</OpenExample></li>
        <li><OpenExample name="ccvsVariableInductor">Variable Inductor</OpenExample></li>
        <li><OpenExample name="vcvsVariableCapacitor">Variable Capacitor</OpenExample></li>
      </ul>
    </>
  );
}

export function CustomTransformerPage() {
  return (
    <>
      <p>
        You can use the custom transformer element to create more complex
        transformers. Edit the transformer's description to specify what kind
        of transformer you want.
      </p>
      <ul>
        <li>
          <code>1:1</code> is a simple transformer with an equal number of
          turns in the primary and secondary. The inductance of each winding
          is equal to the "Base Inductance".
        </li>
        <li>
          <code>1:10</code> gives you a step-up transformer. The secondary has
          10 times as many turns as the primary (so it has 100 times the base
          inductance).
        </li>
        <li>
          <code>1,2:3</code> gives you a transformer with two primary
          windings. The second primary winding has twice as many turns as the
          first. The secondary winding has 3 times as many. The only
          difference between primary and secondary windings is how they're
          displayed on the screen.
        </li>
        <li><code>1:.5+.5</code> gives you a tapped transformer.</li>
        <li>
          <code>1:1+2</code> gives you a tapped transformer where the first
          part of the secondary has as many turns as the primary, and the
          second part has twice as many.
        </li>
        <li>
          <code>1,-1:1</code> gives you a transformer with two primary
          windings, where the bottom winding has its polarity swapped.
        </li>
      </ul>
      <p>
        So, the description is a list of windings separated by commas, with{' '}
        <code>:</code> to separate primary and secondary, and <code>+</code>{' '}
        to separate parts of a tapped coil.
      </p>
    </>
  );
}

export function OpAmpRealPage() {
  return (
    <>
      <p>
        The ideal op-amp element uses an ideal approximation to op-amp
        behavior. It has infinite slew rate and output current.
      </p>
      <p>
        The real op-amp element uses a subcircuit to emulate a real op-amp
        implementation with finite slew rate and output current. Presently
        the port offers the LM741; an LM324 file loads but runs the 741
        model.
      </p>
      <p>
        You can also modify the slew rate or output current, which will modify
        the circuit to change these values from the default.
      </p>
      <p>
        These subcircuits are complicated, so you may run into problems with
        convergence, especially if you increase the slew rate. Try decreasing
        the time step size if this happens.
      </p>
    </>
  );
}
