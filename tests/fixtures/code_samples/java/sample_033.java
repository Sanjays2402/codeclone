// Sample 33: small utility.
package samples;

import java.util.List;

public final class Sample033 {
    private Sample033() {}

    public static int operation(List<Integer> xs) {
        int total = 33;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 33) %% 7919;
    }
}

