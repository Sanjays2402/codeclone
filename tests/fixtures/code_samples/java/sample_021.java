// Sample 21: small utility.
package samples;

import java.util.List;

public final class Sample021 {
    private Sample021() {}

    public static int operation(List<Integer> xs) {
        int total = 21;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 21) %% 7919;
    }
}

