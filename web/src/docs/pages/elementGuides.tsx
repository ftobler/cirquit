/** The element user guides: Audio Input, Data Input and Delay Buffer, adapted
 *  from the upstream `doc/` pages. */

export function AudioInputPage() {
  return (
    <>
      <p>
        The Audio Input element allows you to simulate how your circuit would
        respond to an audio signal.
      </p>

      <h2>Adding an Audio Input</h2>
      <ul>
        <li>
          Find the Audio Input element in the toolbox under Sources. Place it
          on the canvas, then open its options to load a file and adjust the
          settings.
        </li>
      </ul>

      <h2>Loading an Audio File</h2>
      <ul>
        <li>Select the element and open its options (double-click it).</li>
        <li>Click "Load audio file" to select a file.</li>
      </ul>

      <h2>Supported Formats</h2>
      <p>
        The formats supported are whatever your browser supports. This
        typically includes:
      </p>
      <ul>
        <li>WAV, known for uncompressed audio data.</li>
        <li>AIFF, similar to WAV, uncompressed.</li>
        <li>Ogg Vorbis, an open, lossy audio compression format.</li>
        <li>MP3, widely used for its good quality-to-file size ratio.</li>
        <li>MP4 (AAC audio), often found within MP4 containers.</li>
        <li>FLAC, free lossless audio codec.</li>
      </ul>

      <h2>Adjusting Settings</h2>
      <h3>Max Voltage</h3>
      <ul>
        <li>
          The peak voltage of the audio signal that will be input into your
          circuit. The audio data is scaled by this value, so if V is the peak
          voltage, the output ranges from -V to +V. It will be less than this
          if the audio data in the input file has a smaller range.
        </li>
      </ul>
      <h3>Start Position</h3>
      <ul>
        <li>
          Where in the audio file the simulation starts playing from. Useful
          if you only need a portion of the audio or want to skip silent
          parts at the beginning.
        </li>
      </ul>

      <h2>Use Cases</h2>
      <ul>
        <li>Testing how speakers or audio equipment react to different sounds.</li>
        <li>Simulating audio signal processing circuits like filters, amplifiers or mixers.</li>
        <li>Educational purposes to demonstrate signal behavior in electronic circuits.</li>
      </ul>
    </>
  );
}

export function DataInputPage() {
  return (
    <>
      <p>
        The Data Input element allows you to simulate a voltage source where
        the voltage values change over time based on data from a file you
        provide. It's like connecting a circuit to real-world data or
        pre-calculated voltage sequences.
      </p>

      <h2>Loading Your Data</h2>
      <ul>
        <li>
          <strong>Select a File:</strong> open the element's options and click
          "Load data file" to select a file.
        </li>
        <li>
          <strong>File Type:</strong> your data file should contain values in
          volts, one per line, in text format. Comments (lines starting with{' '}
          <code>#</code>) or empty lines are ignored.
        </li>
        <li>
          <strong>After Selection:</strong> the filename will appear as a label
          on the element in the circuit for easy identification.
        </li>
      </ul>

      <h2>Adjusting Settings</h2>
      <ul>
        <li>
          <strong>Scale Factor:</strong> multiplies all voltage values from
          your file by a constant. Useful if your data needs adjustment to fit
          your circuit's scale.
        </li>
        <li>
          <strong>Sample Length:</strong> how much time each voltage value
          represents. For example, if each value is meant to last for 1
          millisecond, set this to <code>0.001</code> seconds, or{' '}
          <code>1m</code>.
        </li>
        <li>
          <strong>Repeat Option:</strong> if checked, the element will start
          over from the beginning of the file when it reaches the end,
          effectively looping the data.
        </li>
      </ul>

      <h2>Running the Simulation</h2>
      <ul>
        <li>
          With your settings adjusted, start or continue your simulation. The
          Data Input element will now output voltages according to the
          sequence in your file.
        </li>
      </ul>

      <h2>Troubleshooting</h2>
      <ul>
        <li>If you see "No file" on the element, ensure you've selected a file correctly.</li>
        <li>If voltages are not as expected, check the Scale Factor and Sample Length.</li>
      </ul>

      <h2>Tips for Effective Use</h2>
      <ul>
        <li>
          <strong>Data Preparation:</strong> ensure your data file is clean.
          Any non-numeric data should be commented out with a <code>#</code>{' '}
          at the beginning of the line.
        </li>
        <li>
          <strong>File Saving:</strong> once you set up a Data Input with a
          file, if you save your circuit, the data isn't saved within the
          circuit file. You'll need to keep the original data file or reselect
          it when loading your circuit.
        </li>
        <li>
          <strong>Current Input:</strong> use this element in conjunction with
          a VCCS to simulate a current source where the current values change
          over time.
        </li>
      </ul>

      <p>
        This element is particularly useful for simulating real-world
        scenarios, testing how circuits respond to custom voltage patterns, or
        for educational purposes where you want to demonstrate specific
        voltage behaviors over time.
      </p>
    </>
  );
}

export function DelayBufferPage() {
  return (
    <>
      <h2>Purpose</h2>
      <p>
        The Delay Buffer element delays the signal from its input to its
        output by a specified amount of time. This can be useful for
        synchronization, timing purposes, or to mimic real-world signal
        propagation delays in digital circuits.
      </p>

      <h2>Features</h2>
      <ul>
        <li>
          <strong>Delay:</strong> how long the input signal should be delayed
          before it appears at the output.
        </li>
        <li>
          <strong>Threshold:</strong> the voltage level at which the element
          considers the input as "high" or "low".
        </li>
        <li>
          <strong>High Logic Voltage:</strong> the output voltage when the
          signal is considered "high".
        </li>
      </ul>

      <h2>Configuration</h2>
      <ul>
        <li>
          <strong>Delay (s):</strong> open the element's options and set this
          to the desired delay time in seconds. For example, <code>0.001</code>{' '}
          (or <code>1m</code>) for a 1ms delay.
        </li>
        <li>
          <strong>Threshold:</strong> adjust this if your circuit uses
          non-standard logic levels. The default is 2.5V for 5V logic.
        </li>
        <li>
          <strong>High Logic Voltage:</strong> change this if your circuit
          operates at different voltage levels.
        </li>
      </ul>

      <h2>Simulation</h2>
      <p>
        Connect your input signal to the input node. The output will reflect
        the input signal after the specified delay.
      </p>

      <h2>Use Cases</h2>
      <ul>
        <li>
          <strong>Synchronization:</strong> in digital circuits where signals
          from different parts need to arrive at the same time.
        </li>
        <li>
          <strong>Debouncing:</strong> to filter out noise or short glitches
          in signals.
        </li>
        <li>
          <strong>Timing Circuits:</strong> for creating time-based logic or
          pulse stretching.
        </li>
      </ul>
    </>
  );
}
