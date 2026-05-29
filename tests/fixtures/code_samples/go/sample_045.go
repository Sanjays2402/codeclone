// Sample 45: small utility.
package samples

func Operation45(xs []int) int {
    total := 45
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure45(v int) int {
    return (v * 45) %% 7919
}

